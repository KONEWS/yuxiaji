export function splitLegacyTags(value: string): string[] {
  return value.split(/[,，、]/).map(tag => tag.trim()).filter(Boolean);
}

/** Business-data snapshots. Credentials and authentication tables are never read. */
export const SITE_BACKUP_FORMAT = "yuexiaji-site-backup";
export const SITE_BACKUP_VERSION = 1;
export const SITE_BACKUP_MAX_BYTES = 32 * 1024 * 1024;

type Cell = string | number | null;
export type SiteBackupRow = Record<string, Cell>;
type Column = {
  kind: "text" | "integer" | "number";
  nullable?: boolean;
  min?: number;
  max?: number;
  json?: "array" | "object";
  legacyTags?: boolean;
  url?: "absolute" | "asset" | "reference" | "sources";
  values?: readonly Cell[];
};
const text = (max = 16_384): Column => ({ kind: "text", max });
const integer = (min = 0, max = Number.MAX_SAFE_INTEGER): Column => ({ kind: "integer", min, max });
const number = (min = 0, max = Number.MAX_SAFE_INTEGER): Column => ({ kind: "number", min, max });
const nullable = (column: Column): Column => ({ ...column, nullable: true });
const json = (shape: "array" | "object"): Column => ({ ...text(512_000), json: shape });
const url = (kind: "absolute" | "asset" = "asset"): Column => ({ ...text(4096), url: kind });
const sources = (): Column => ({ ...text(4096), url: "sources" });
const flag: Column = { ...integer(0, 1), values: [0, 1] };
const timestamp = integer(0, 8_640_000_000_000_000);

// Keep this list explicit: a newly added credential-bearing column must never
// start appearing in backups merely because a table's schema changed.
const TABLE_COLUMNS = {
  user_subjects: {
    id: integer(1), type: { ...text(), values: ["anime", "movie", "tv", "game", "light_novel", "manga", "music", "visual", "video"] },
    subject_id: nullable(integer()), title: text(), jp: text(), note: text(100_000),
    progress: integer(), total: integer(), status: text(), kind: text(), score: nullable(integer(0, 10)),
    next: nullable(text()), image: nullable(url()), global_score: nullable(number(0, 10)), source: text(),
    collection: text(), tags: { ...json("array"), legacyTags: true }, music_album: text(), music_artist: text(), lyricist: text(), composer: text(),
    anime_song: flag, visual_subtype: text(), video_subtype: text(), thumbnail: url(), source_url: sources(),
    pixiv_pid: text(), author: text(), twitter_source: { ...text(500), url: "reference" }, character_tags: { ...json("array"), legacyTags: true }, metadata: json("object"), updated_at: timestamp,
  },
  user_subject_images: {
    id: integer(1), subject_id: integer(1), thumbnail: url(), source_url: sources(), image_hash: text(128),
    sort_order: integer(), is_cover: flag, width: nullable(integer(0, 100_000)), height: nullable(integer(0, 100_000)),
    mime: text(80), created_at: timestamp, updated_at: timestamp,
  },
  media_storage_links: {
    id: integer(1), media_id: integer(1), provider: text(64), label: text(120), url: url("absolute"), path: text(1000),
    is_primary: flag, note: text(1000), state: { ...text(), values: ["linked", "verified", "uncertain", "failed"] },
    operation_key: text(256), object_count: nullable(integer()), total_bytes: nullable(integer()),
    manifest_sha256: text(64), verified_at: nullable(timestamp), created_at: timestamp, updated_at: timestamp,
  },
  user_devices: {
    id: integer(1), name: text(), category: text(), sub_category: text(), status: text(), price: nullable(number()), currency: text(),
    purchase_date: nullable(text()), receipt_image: nullable(url()), cover_image: nullable(url()),
    cover_position_x: integer(0, 100), cover_position_y: integer(0, 100), cover_zoom: integer(25, 500),
    cover_offset_x: number(-50, 50), cover_offset_y: number(-50, 50), tags: { ...json("array"), legacyTags: true }, rating: nullable(integer(0, 10)),
    review: text(100_000), updated_at: timestamp,
  },
  user_state: {
    collections_json: json("array"), bangumi_sync_types_json: json("array"), sync_settings_json: json("object"),
    media_order_json: json("array"), device_subcategories_json: json("object"), device_category_labels_json: json("object"),
    visual_subtype_labels_json: json("object"), video_subtype_labels_json: json("object"), avatar_image: url(), font: text(),
    softness: number(0, 100), background_version: number(), primary_color: text(64), accent_color: text(64), title_mode: text(), updated_at: timestamp,
  },
  anime_airing_schedule: {
    id: integer(1), subject_id: integer(), title: text(), jp_title: text(), weekday: integer(1, 7), air_time: text(), timezone: text(),
    next_episode: nullable(integer()), next_air_at: nullable(timestamp), season: text(), year: integer(), source: text(),
    metadata: json("object"), last_checked: timestamp, created_at: timestamp, updated_at: timestamp,
  },
} satisfies Record<string, Record<string, Column>>;

export type SiteBackupTable = keyof typeof TABLE_COLUMNS;
export const SITE_BACKUP_TABLE_NAMES = Object.keys(TABLE_COLUMNS) as SiteBackupTable[];
export const COLLECTION_BACKUP_TABLE_NAMES: SiteBackupTable[] = ["user_subjects", "user_subject_images", "media_storage_links"];
type Counts = { subjects: number; images: number; storageLinks: number; devices: number; settings: number; schedules: number };
export type SiteBackup = {
  format: typeof SITE_BACKUP_FORMAT;
  version: typeof SITE_BACKUP_VERSION;
  exportedAt: string;
  tables: Record<SiteBackupTable, SiteBackupRow[]>;
  counts: Counts;
};

export class SiteBackupError extends Error {
  readonly code: string;
  readonly status: number;
  readonly rolledBack: boolean;
  constructor(message: string, code = "invalid_site_backup", status = 400, rolledBack = true) {
    super(message);
    this.name = "SiteBackupError";
    this.code = code;
    this.status = status;
    this.rolledBack = rolledBack;
  }
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const quote = (value: string) => `"${value}"`;
const owned = (table: SiteBackupTable) => table !== "anime_airing_schedule";
const columns = (table: SiteBackupTable) => Object.keys(TABLE_COLUMNS[table]);
const control = /[\u0000-\u001f\u007f\\]/;
const credentialKey = /^(?:password|passwordHash|password_hash|secret|token|accessToken|access_token|refreshToken|refresh_token|credentials?|cookie|authorization|apiKey|api_key|sessionToken|session_token)$/i;

function exactKeys(value: Record<string, unknown>, expected: readonly string[], context: string) {
  const allowed = new Set(expected);
  if (Object.keys(value).some((key) => !allowed.has(key)) || expected.some((key) => !Object.hasOwn(value, key))) {
    throw new SiteBackupError(`${context} 的字段不完整或包含不允许的字段`);
  }
}

function checkJson(value: unknown, context: string, depth = 0): void {
  if (depth > 30) throw new SiteBackupError(`${context} 嵌套层数过多`);
  if (Array.isArray(value)) {
    for (const item of value) checkJson(item, context, depth + 1);
  } else if (record(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (credentialKey.test(key) || key === "__proto__" || key === "constructor" || key === "prototype") {
        throw new SiteBackupError(`${context} 不允许包含凭据或特殊字段 ${key}`);
      }
      checkJson(item, context, depth + 1);
    }
  }
}

export function validateBackupUrl(value: string, context: string, absolute = false): void {
  if (!value) return;
  if (control.test(value) || value !== value.trim() || value.startsWith("//")) throw new SiteBackupError(`${context} 地址无效`);
  if (!absolute && value.startsWith("/")) return;
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new SiteBackupError(`${context} 地址无效`); }
  if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new SiteBackupError(`${context} 只接受不含账号密码的 HTTP/HTTPS 地址`);
  }
}

/** Historical source fields can contain one URL per line. Validate a trimmed
 * copy of each line while preserving the exact original text in the snapshot. */
function validateSourceUrls(value: string, context: string): void {
  for (const line of value.split(/\r\n|\r|\n/)) validateBackupUrl(line.trim(), context);
}

function readCell(value: unknown, spec: Column, context: string, normalizeTags: boolean): Cell {
  if (value === null && spec.nullable) return null;
  if (spec.kind === "text") {
    if (typeof value !== "string" || value.length > (spec.max ?? 16_384)) throw new SiteBackupError(`${context} 字符串无效或过长`);
    // The existing X/Twitter field also accepts @handles and bare domains.
    // Preserve those values while still rejecting executable URL schemes.
    if (spec.url === "sources") validateSourceUrls(value, context);
    else if (spec.url === "reference" && !/^[a-z][a-z\d+.-]*:/i.test(value) && !value.startsWith("/")) {
      if (control.test(value)) throw new SiteBackupError(`${context} 来源无效`);
    } else if (spec.url) validateBackupUrl(value, context, spec.url === "absolute");
    if (spec.json) {
      let parsed: unknown;
      try { parsed = JSON.parse(value); } catch {
        if (!spec.legacyTags || /^\s*[[{"]/.test(value)) throw new SiteBackupError(context + " 不是有效 JSON");
        // Preserve the stored spelling for fingerprints and D1 compare-and-swap guards.
        const tags = splitLegacyTags(value);
        return normalizeTags ? JSON.stringify(tags) : value;
      }
      if (spec.json === "array" ? !Array.isArray(parsed) : !record(parsed)) throw new SiteBackupError(`${context} JSON 类型不正确`);
      checkJson(parsed, context);
    }
  } else if (typeof value !== "number" || !Number.isFinite(value) || (spec.kind === "integer" && !Number.isSafeInteger(value)) || value < (spec.min ?? 0) || value > (spec.max ?? Number.MAX_SAFE_INTEGER)) {
    throw new SiteBackupError(`${context} 数值无效`);
  }
  if (spec.values && !spec.values.includes(value as Cell)) throw new SiteBackupError(`${context} 取值无效`);
  return value as Cell;
}

function countTables(tables: SiteBackup["tables"]): Counts {
  return {
    subjects: tables.user_subjects.length, images: tables.user_subject_images.length, storageLinks: tables.media_storage_links.length,
    devices: tables.user_devices.length, settings: tables.user_state.length, schedules: tables.anime_airing_schedule.length,
  };
}

function validateRelations(tables: SiteBackup["tables"]) {
  const subjectIds = new Set(tables.user_subjects.map((row) => row.id));
  const seenImages = new Set<string>();
  const imageCounts = new Map<Cell, number>();
  for (const row of tables.user_subject_images) {
    if (!subjectIds.has(row.subject_id)) throw new SiteBackupError("画廊图片关联的收藏不存在");
    if (!row.thumbnail) throw new SiteBackupError("画廊图片缺少地址");
    const key = JSON.stringify([row.subject_id, row.thumbnail]);
    if (seenImages.has(key)) throw new SiteBackupError("同一收藏包含重复的画廊图片地址");
    seenImages.add(key);
    const count = (imageCounts.get(row.subject_id) ?? 0) + 1;
    if (count > 60) throw new SiteBackupError("同一收藏的画廊图片超过 60 张");
    imageCounts.set(row.subject_id, count);
  }
  const linkCounts = new Map<Cell, number>();
  const primary = new Set<Cell>();
  for (const row of tables.media_storage_links) {
    if (!subjectIds.has(row.media_id)) throw new SiteBackupError("存储关联的收藏不存在");
    if (!row.provider || (!row.url && !row.path)) throw new SiteBackupError("存储关联缺少网盘名称或地址/路径");
    if (row.manifest_sha256 && !/^[a-f\d]{64}$/i.test(String(row.manifest_sha256))) throw new SiteBackupError("存储关联 SHA-256 无效");
    const count = (linkCounts.get(row.media_id) ?? 0) + 1;
    if (count > 12) throw new SiteBackupError("同一收藏的存储关联超过 12 条");
    linkCounts.set(row.media_id, count);
    if (row.is_primary) {
      if (primary.has(row.media_id)) throw new SiteBackupError("同一收藏存在多个主存储关联");
      primary.add(row.media_id);
    }
  }
  const schedules = new Set<string>();
  for (const row of tables.anime_airing_schedule) {
    const key = JSON.stringify([row.source, row.subject_id, row.season, row.year]);
    if (schedules.has(key)) throw new SiteBackupError("放送计划包含重复的来源/作品/季度记录");
    schedules.add(key);
  }
}

/** Reject unknown tables/columns and malformed relationships before any write. */
export function parseSiteBackup(value: unknown, normalizeTags = false): SiteBackup {
  if (!record(value)) throw new SiteBackupError("全站备份必须是 JSON 对象");
  exactKeys(value, ["format", "version", "exportedAt", "tables", "counts"], "全站备份");
  if (value.format !== SITE_BACKUP_FORMAT || value.version !== SITE_BACKUP_VERSION) throw new SiteBackupError("不支持的全站备份格式或版本");
  if (typeof value.exportedAt !== "string" || !Number.isFinite(Date.parse(value.exportedAt))) throw new SiteBackupError("备份导出时间无效");
  if (!record(value.tables) || !record(value.counts)) throw new SiteBackupError("全站备份缺少数据表或数量");
  exactKeys(value.tables, SITE_BACKUP_TABLE_NAMES, "备份数据表");
  const tables = {} as SiteBackup["tables"];
  let total = 0;
  for (const table of SITE_BACKUP_TABLE_NAMES) {
    const raw = value.tables[table];
    if (!Array.isArray(raw) || (table === "user_state" && raw.length > 1)) throw new SiteBackupError(`${table} 记录格式无效`);
    total += raw.length;
    if (total > 200_000) throw new SiteBackupError("备份记录总数超过 200000 条");
    const specs: Record<string, Column> = TABLE_COLUMNS[table];
    const keys = columns(table);
    const ids = new Set<Cell>();
    tables[table] = raw.map((item, index) => {
      const context = `${table} 第 ${index + 1} 条`;
      if (!record(item)) throw new SiteBackupError(`${context} 格式无效`);
      exactKeys(item, keys, context);
      const row: SiteBackupRow = {};
      for (const key of keys) row[key] = readCell(item[key], specs[key], `${context}.${key}`, normalizeTags);
      if (Object.hasOwn(row, "id")) {
        if (ids.has(row.id)) throw new SiteBackupError(`${table} 包含重复 ID`);
        ids.add(row.id);
      }
      if ((table === "user_subjects" || table === "anime_airing_schedule") && !String(row.title).trim()) throw new SiteBackupError(`${context} 缺少标题`);
      return row;
    }).sort((a, b) => Number(a.id ?? 0) - Number(b.id ?? 0));
  }
  const counts = countTables(tables);
  exactKeys(value.counts, Object.keys(counts), "备份数量");
  for (const [key, count] of Object.entries(counts)) if (value.counts[key] !== count) throw new SiteBackupError("备份声明的数量与实际数据不一致");
  validateRelations(tables);
  const backup: SiteBackup = { format: SITE_BACKUP_FORMAT, version: SITE_BACKUP_VERSION, exportedAt: value.exportedAt, tables, counts };
  if (new TextEncoder().encode(JSON.stringify(backup)).byteLength > SITE_BACKUP_MAX_BYTES) throw new SiteBackupError("备份业务数据超过 32 MiB");
  return backup;
}

function selectSql(table: SiteBackupTable) {
  return `SELECT ${columns(table).map(quote).join(",")} FROM ${quote(table)}${owned(table) ? " WHERE user_key = ?" : ""}${table === "user_state" ? "" : " ORDER BY id"}`;
}

/** D1 batch runs all SELECTs in one transaction, so related tables agree. */
export async function exportSiteBackup(db: D1Database, userKey: string): Promise<SiteBackup> {
  return exportSnapshotTables(db, userKey, SITE_BACKUP_TABLE_NAMES);
}

/** Legacy collection imports must not depend on unrelated settings or devices. */
export async function exportCollectionSnapshot(db: D1Database, userKey: string): Promise<SiteBackup> {
  return exportSnapshotTables(db, userKey, COLLECTION_BACKUP_TABLE_NAMES);
}

async function exportSnapshotTables(db: D1Database, userKey: string, names: SiteBackupTable[]): Promise<SiteBackup> {
  const results = await db.batch<SiteBackupRow>(names.map((table) => {
    const statement = db.prepare(selectSql(table));
    return owned(table) ? statement.bind(userKey) : statement;
  }));
  const tables = {} as SiteBackup["tables"];
  for (const table of SITE_BACKUP_TABLE_NAMES) tables[table] = [];
  names.forEach((table, index) => {
    if (!results[index]?.success || !Array.isArray(results[index].results)) throw new SiteBackupError("读取备份数据失败", "backup_read_failed", 503);
    tables[table] = results[index].results;
  });
  return parseSiteBackup({ format: SITE_BACKUP_FORMAT, version: SITE_BACKUP_VERSION, exportedAt: new Date().toISOString(), tables, counts: countTables(tables) });
}

export async function siteBackupFingerprint(backup: SiteBackup): Promise<string> {
  const parsed = parseSiteBackup(backup);
  const data = JSON.stringify({ format: parsed.format, version: parsed.version, tables: parsed.tables, counts: parsed.counts });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// One JSON parameter carries many rows without exceeding D1's 100-variable
// statement limit. Bounded chunks also stay below D1's per-value size limit.
function chunks(rows: SiteBackupRow[]): string[] {
  const result: string[] = [];
  let group: string[] = [];
  let bytes = 2;
  const encoder = new TextEncoder();
  for (const row of rows) {
    const serialized = JSON.stringify(row);
    const size = encoder.encode(serialized).byteLength + 1;
    if (size > 1_000_000) throw new SiteBackupError("单条备份记录超过数据库恢复上限");
    if (bytes + size > 1_000_000 && group.length) { result.push(`[${group.join(",")}]`); group = []; bytes = 2; }
    group.push(serialized); bytes += size;
  }
  if (group.length) result.push(`[${group.join(",")}]`);
  return result;
}

/** These guards must be prepended to the SAME batch as the mutations. */
export function siteBackupGuardStatements(db: D1Database, userKey: string, expected: SiteBackup, names: SiteBackupTable[] = SITE_BACKUP_TABLE_NAMES): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (const table of names) {
    const where = owned(table) ? " WHERE user_key = ?" : "";
    const count = db.prepare(`SELECT CASE WHEN (SELECT count(*) FROM ${quote(table)}${where}) = ? THEN 1 ELSE json('site_backup_conflict') END`);
    statements.push(owned(table) ? count.bind(userKey, expected.tables[table].length) : count.bind(expected.tables[table].length));
    const fields = columns(table);
    const projection = fields.map((field) => `json_extract(value, '$.${field}') AS ${quote(field)}`).join(",");
    for (const chunk of chunks(expected.tables[table])) {
      // Equal row counts plus membership of every unique-ID expected row gives
      // set equality, including removals and newly added rows.
      const statement = db.prepare(`WITH expected AS (SELECT ${projection} FROM json_each(?)) SELECT CASE WHEN NOT EXISTS (SELECT * FROM expected EXCEPT SELECT ${fields.map(quote).join(",")} FROM ${quote(table)}${where}) THEN 1 ELSE json('site_backup_conflict') END`);
      statements.push(owned(table) ? statement.bind(chunk, userKey) : statement.bind(chunk));
    }
  }
  return statements;
}

/** D1 constraint/SQL failures roll back; transport failures leave the outcome unknown. */
export function siteBackupWriteError(error: unknown): SiteBackupError {
  if (error instanceof SiteBackupError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/malformed JSON/i.test(message)) return new SiteBackupError("预览后数据已发生变化，请重新预览后再恢复。", "backup_conflict", 409);
  if (/SQLITE_(?:CONSTRAINT|ERROR|ABORT|MISMATCH|TOOBIG|RANGE)|constraint failed|injected.*failure|syntax error|no such (?:table|column|function)|too many SQL variables|datatype mismatch/i.test(message)
    && !/timeout|timed out|network|fetch failed|connection|internal error|temporarily unavailable|overloaded/i.test(message)) {
    return new SiteBackupError("数据库恢复失败，整批修改已回滚，现有数据保持不变。", "backup_restore_failed", 500);
  }
  return new SiteBackupError("数据库未返回确定结果，请先重新读取当前数据核对，再决定是否重试。", "backup_outcome_unknown", 503, false);
}

/** Exact replacement, including deletions, in one all-or-nothing D1 batch. */
export async function restoreSiteBackup(db: D1Database, userKey: string, value: SiteBackup, expectedCurrent?: SiteBackup, coverHashes?: Array<{ image: string; sourceHash: string }>): Promise<void> {
  const backup = parseSiteBackup(value, true);
  const current = expectedCurrent ? parseSiteBackup(expectedCurrent) : await exportSiteBackup(db, userKey);
  const statements = siteBackupGuardStatements(db, userKey, current);
  // Refuse malformed cross-owner foreign keys instead of cascading into them.
  for (const [table, foreign] of [["user_subject_images", "subject_id"], ["media_storage_links", "media_id"]]) {
    statements.push(db.prepare(`SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM ${quote(table)} child JOIN user_subjects parent ON parent.id = child.${quote(foreign)} WHERE parent.user_key = ? AND child.user_key <> ?) THEN 1 ELSE json('site_backup_conflict') END`).bind(userKey, userKey));
  }
  const deleteOrder: SiteBackupTable[] = ["media_storage_links", "user_subject_images", "user_subjects", "user_devices", "user_state", "anime_airing_schedule"];
  for (const table of deleteOrder) {
    const statement = db.prepare(`DELETE FROM ${quote(table)}${owned(table) ? " WHERE user_key = ?" : ""}`);
    statements.push(owned(table) ? statement.bind(userKey) : statement);
  }
  for (const table of SITE_BACKUP_TABLE_NAMES) {
    const fields = columns(table);
    const insertFields = [...(owned(table) ? ["user_key"] : []), ...(table === "user_state" ? ["anime_json"] : []), ...fields];
    const values = [...(owned(table) ? ["?"] : []), ...(table === "user_state" ? ["'[]'"] : []), ...fields.map((field) => `json_extract(value, '$.${field}')`)];
    for (const chunk of chunks(backup.tables[table])) {
      const statement = db.prepare(`INSERT INTO ${quote(table)} (${insertFields.map(quote).join(",")}) SELECT ${values.join(",")} FROM json_each(?)`);
      statements.push(owned(table) ? statement.bind(userKey, chunk) : statement.bind(chunk));
    }
  }
  if (coverHashes) {
    statements.push(db.prepare("DELETE FROM restored_cover_hashes WHERE user_key=?").bind(userKey));
    for (const chunk of chunks(coverHashes)) {
      statements.push(db.prepare("INSERT OR IGNORE INTO restored_cover_hashes(user_key,image,source_hash) SELECT ?,json_extract(value,'$.image'),json_extract(value,'$.sourceHash') FROM json_each(?)").bind(userKey, chunk));
    }
  }
  try { await db.batch(statements); } catch (error) { throw siteBackupWriteError(error); }
}

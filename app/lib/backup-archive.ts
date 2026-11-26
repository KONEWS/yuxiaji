import { backupCoverHashes, parseCoverHashes, type CoverHash } from "./backup-cover-hashes";
import { crc32 as nativeCrc32 } from "node:zlib";
import { exportSiteBackup, parseSiteBackup, restoreSiteBackup, siteBackupFingerprint, SiteBackupError, type SiteBackup } from "./site-backup-data";
import { createBackupZip, createZipTemplate, type ZipRangeIndex, type ZipSource } from "./backup-zip";
import { putVersionedImage } from "./versioned-image";

export type ArchiveKind = "manual" | "scheduled" | "before-restore" | "uploaded";
export type ArchiveSummary = {
  id: string; createdAt: string; kind: ArchiveKind; status: "pending" | "complete" | "failed";
  counts: SiteBackup["counts"]; assetCount: number; assetBytes: number;
  processedAssets: number; totalAssets: number; downloadParts: number; error?: string;
};
export type BackupSettings = { enabled: boolean; retentionDays: number; scheduleLabel: string };
type AssetKind = "media" | "device" | "avatar" | "background";
export type BackupAsset = { kind: AssetKind; purpose?: "cover" | "receipt"; urls: string[]; sha256: string; size: number; contentType: string; crc32: number };
export type ArchiveManifest = { format: "yuexiaji-archive"; version: 1; createdAt: string; data: SiteBackup; dataSha256: string; coverHashes?: CoverHash[]; assets: BackupAsset[] };
type AssetSource = { kind: AssetKind; purpose?: "cover" | "receipt"; urls: string[]; key: string; fallbackKey?: string };
type ArchiveRecord = ArchiveSummary & { manifest: ArchiveManifest; sources: AssetSource[]; _etag?: string; failureCount?: number };
type RestoreProgress = { _etag?: string; archiveId: string; preRestoreBackupId: string; fingerprint: string; processed: number; urls: Record<string, string>; backgroundVersion?: number; status: "preparing" | "committing" | "complete" };
export type BackupEnv = { DB: D1Database; BUCKET: R2Bucket; DEFAULT_USER_ID?: string; BACKUP_COMPONENT_ENABLED?: string; BAIDU_BACKUP_APP_NAME?: string; assertBackupLease?: () => Promise<void> };
const MAX_MANIFEST_BYTES = 20 * 1024 * 1024;
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_ASSETS = 25000;
const ZIP_PART_ASSETS = 400;
const JSON_HEADERS = { contentType: "application/json; charset=utf-8" };
const encoder = new TextEncoder();
const ID = /^[a-z0-9-]{10,90}$/;
const HASH = /^[a-f0-9]{64}$/;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const defaults: BackupSettings = { enabled: true, retentionDays: 14, scheduleLabel: "每天北京时间 04:00" };
export function backupUser(env: BackupEnv) { return env.DEFAULT_USER_ID?.trim() || "owner"; }
export async function backupSha256(bytes: ArrayBuffer | Uint8Array | string) {
  const value = typeof bytes === "string" ? encoder.encode(bytes) : bytes;
  const hash = await crypto.subtle.digest("SHA-256", value as BufferSource);
  return Array.from(new Uint8Array(hash), (n) => n.toString(16).padStart(2, "0")).join("");
}
async function root(user: string) { return "backups-v2/" + await backupSha256(user) + "/"; }
async function recordKey(user: string, id: string) {
  if (!ID.test(id)) throw new SiteBackupError("备份编号无效");
  return await root(user) + "records/" + id + ".json";
}
async function blobKey(user: string, hash: string) {
  if (!HASH.test(hash)) throw new SiteBackupError("图片校验值无效");
  return await root(user) + "blobs/" + hash;
}
async function readJson<T>(bucket: R2Bucket, key: string): Promise<T | null> {
  const value = await bucket.get(key); if (!value) return null;
  const parsed = await value.json<T>();
  if (parsed && typeof parsed === "object") Object.defineProperty(parsed, "_etag", { value: value.etag, writable: true, enumerable: false });
  return parsed;
}
function summary(record: ArchiveRecord): ArchiveSummary {
  const { id, createdAt, kind, status, counts, assetCount, assetBytes, processedAssets, totalAssets, error } = record;
  return { id, createdAt, kind, status, counts, assetCount, assetBytes, processedAssets, totalAssets, downloadParts: Math.max(1, Math.ceil(new Set(record.manifest.assets.map((asset) => asset.sha256)).size / ZIP_PART_ASSETS)), ...(error ? { error } : {}) };
}
async function saveRecord(bucket: R2Bucket, user: string, record: ArchiveRecord) {
  const text = JSON.stringify(record);
  if (encoder.encode(text).length > MAX_MANIFEST_BYTES) throw new SiteBackupError("备份数据清单超过 20 MiB，请先精简过大的备注或图片清单");
  const saved = await bucket.put(await recordKey(user, record.id), text, { httpMetadata: JSON_HEADERS, customMetadata: { summary: JSON.stringify(summary(record)) }, onlyIf: record._etag ? { etagMatches: record._etag } : { etagDoesNotMatch: "*" } });
  if (!saved) throw new SiteBackupError("备份进度已由另一项操作更新，请刷新后继续", "backup_conflict", 409);
  Object.defineProperty(record, "_etag", { value: saved.etag, writable: true, enumerable: false });
}
async function readRecord(bucket: R2Bucket, user: string, id: string) {
  const record = await readJson<ArchiveRecord>(bucket, await recordKey(user, id));
  if (!record) throw new SiteBackupError("找不到这份备份", "backup_not_found", 404);
  return record;
}
export async function withBackupLock<T>(bucket: R2Bucket, user: string, action: (assertLease: () => Promise<void>) => Promise<T>): Promise<T> {
  const key = await root(user) + "lock.json";
  const current = await bucket.get(key);
  const busy = () => new SiteBackupError("另一项备份操作正在进行，请稍后再试", "backup_busy", 409);
  if (current && (await current.json<{ expiresAt: number }>()).expiresAt > Date.now()) throw busy();
  let lease = await bucket.put(key, JSON.stringify({ expiresAt: Date.now() + 120000 }), {
    httpMetadata: JSON_HEADERS, onlyIf: current ? { etagMatches: current.etag } : { etagDoesNotMatch: "*" },
  });
  if (!lease) throw busy();
  let done = false; let lost = false; let renewing: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const renew = () => {
    if (renewing) return renewing;
    renewing = (async () => {
      const next = await bucket.put(key, JSON.stringify({ expiresAt: Date.now() + 120000 }), { httpMetadata: JSON_HEADERS, onlyIf: { etagMatches: lease!.etag } });
      if (!next) { lost = true; throw busy(); } lease = next;
    })().catch((error) => { lost = true; throw error; }).finally(() => { renewing = null; });
    return renewing;
  };
  const heartbeat = async () => {
    if (done) return;
    try { await renew(); } catch { lost = true; }
    if (!done && !lost) timer = setTimeout(heartbeat, 30000);
  };
  timer = setTimeout(heartbeat, 30000);
  const assertLease = async () => { if (lost) throw busy(); await renew(); if (lost) throw busy(); };
  try { return await action(assertLease); }
  finally {
    done = true; if (timer) clearTimeout(timer); await Promise.resolve(renewing).catch(() => {});
    await bucket.put(key, '{"expiresAt":0}', { httpMetadata: JSON_HEADERS, onlyIf: { etagMatches: lease!.etag } }).catch(() => null);
  }
}
export async function getBackupSettings(bucket: R2Bucket, user: string): Promise<BackupSettings> {
  const value = await readJson<BackupSettings>(bucket, await root(user) + "settings.json");
  return { ...defaults, ...(value ? { enabled: value.enabled === true, retentionDays: [7, 14, 30].includes(value.retentionDays) ? value.retentionDays : 14 } : {}) };
}
export async function getLastScheduledBackupError(bucket: R2Bucket, user: string): Promise<string | null> {
  const value = await readJson<{ error: string | null }>(bucket, await root(user) + "last-error.json");
  return typeof value?.error === "string" ? value.error : null;
}
export async function configureBackup(bucket: R2Bucket, user: string, enabled: unknown, retentionDays: unknown) {
  if (typeof enabled !== "boolean" || ![7, 14, 30].includes(Number(retentionDays))) throw new SiteBackupError("备份开关或保留天数无效");
  const settings = { ...defaults, enabled, retentionDays: Number(retentionDays) };
  await bucket.put(await root(user) + "settings.json", JSON.stringify(settings), { httpMetadata: JSON_HEADERS }); return settings;
}
export async function listBackupArchives(bucket: R2Bucket, user: string): Promise<ArchiveSummary[]> {
  let cursor: string | undefined; const records: ArchiveSummary[] = [];
  do {
    const list = await bucket.list({ prefix: await root(user) + "records/", cursor, limit: 1000, include: ["customMetadata"] });
    for (const object of list.objects) {
      if (object.customMetadata?.summary) records.push(JSON.parse(object.customMetadata.summary) as ArchiveSummary);
      else { const record = await readJson<ArchiveRecord>(bucket, object.key); if (record) records.push(summary(record)); }
    }
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
function validVersion(value: string) { return /^[0-9]{1,20}$/.test(value) ? Number(value) > 0 : /^[A-Za-z0-9_-]{16,96}$/.test(value); }
function resolveSource(value: string, user: string, hash: string): AssetSource | null {
  if (!value.startsWith("/api/")) return null;
  const url = new URL(value, "https://local.invalid"); const version = url.searchParams.get("v") || "";
  if (url.pathname === "/api/media-assets" && validVersion(version)) return { kind: "media", urls: [value], key: "media-assets/" + hash + "/gallery/" + version };
  if (url.pathname === "/api/device-assets" && validVersion(version)) {
    const purpose = url.searchParams.get("purpose") || "receipt";
    if (purpose === "cover" || purpose === "receipt") return { kind: "device", purpose, urls: [value], key: "device-assets/" + encodeURIComponent(user) + "/" + purpose + "/" + version };
  }
  if (url.pathname === "/api/avatar" || url.pathname === "/api/background") {
    const kind = url.pathname === "/api/avatar" ? "avatar" : "background";
    const base = (kind === "avatar" ? "avatars/" : "backgrounds/") + hash;
    return { kind, urls: [value], key: validVersion(version) ? base + "/" + version : base, ...(validVersion(version) && version.length <= 13 ? { fallbackKey: base } : {}) };
  }
  return null;
}
async function collectSources(data: SiteBackup, user: string) {
  const urls = new Set<string>();
  function visit(value: unknown, depth = 0) {
    if (depth > 35) return;
    if (typeof value === "string") {
      for (const line of value.split(/\r\n|\r|\n/)) if (line.trim().startsWith("/api/")) urls.add(line.trim());
      if (value.startsWith("{") || value.startsWith("[")) { try { visit(JSON.parse(value), depth + 1); } catch { /* Ordinary text. */ } }
    } else if (Array.isArray(value)) value.forEach((v) => visit(v, depth + 1));
    else if (value && typeof value === "object") Object.values(value).forEach((v) => visit(v, depth + 1));
  }
  visit(data.tables);
  for (const row of data.tables.user_state) if (Number(row.background_version) > 0) urls.add("/api/background?v=" + row.background_version);
  const sources = new Map<string, AssetSource>();
  const hash = await backupSha256(user);
  for (const url of urls) {
    const source = resolveSource(url, user, hash); if (!source) continue;
    const previous = sources.get(source.key);
    if (previous) previous.urls.push(url); else sources.set(source.key, source);
  }
  if (sources.size > MAX_ASSETS) throw new SiteBackupError("本站图片数量超过单次备份上限");
  return [...sources.values()];
}
export async function createBackupArchive(env: BackupEnv, user: string, kind: ArchiveKind = "manual", id?: string): Promise<ArchiveSummary> {
  const archiveId = id ?? Date.now() + "-" + crypto.randomUUID();
  const existing = await readJson<ArchiveRecord>(env.BUCKET, await recordKey(user, archiveId));
  if (existing) return summary(existing);
  const data = await exportSiteBackup(env.DB, user); const sources = await collectSources(data, user);
  const coverHashes = await backupCoverHashes(env.DB, user, data);
  const createdAt = new Date().toISOString();
  const record: ArchiveRecord = { id: archiveId, kind, createdAt, status: sources.length ? "pending" : "complete", counts: data.counts,
    assetCount: 0, assetBytes: 0, downloadParts: 1, processedAssets: 0, totalAssets: sources.length, sources,
    manifest: { format: "yuexiaji-archive", version: 1, createdAt, data, dataSha256: await siteBackupFingerprint(data), ...(coverHashes.length ? { coverHashes } : {}), assets: [] } };
  await saveRecord(env.BUCKET, user, record); return summary(record);
}
function detectImage(bytes: Uint8Array): string | null {
  const has = (sig: number[], offset = 0) => sig.every((value, index) => bytes[offset + index] === value);
  if (has([255, 216, 255])) return "image/jpeg";
  if (has([137, 80, 78, 71, 13, 10, 26, 10])) return "image/png";
  if (has([82, 73, 70, 70]) && has([87, 69, 66, 80], 8)) return "image/webp";
  if (has([71, 73, 70, 56, 55, 97]) || has([71, 73, 70, 56, 57, 97])) return "image/gif";
  return null;
}
export async function advanceBackupArchive(env: BackupEnv, user: string, id: string, limit = 8): Promise<ArchiveSummary> {
  const record = await readRecord(env.BUCKET, user, id);
  if (record.status === "complete") return summary(record);
  if (record.kind === "uploaded") throw new SiteBackupError("请重新选择离线备份包以继续上传");
  record.status = "pending"; delete record.error;
  try {
    for (let i = 0; i < limit && record.processedAssets < record.sources.length; i++) {
      await env.assertBackupLease?.();
      const source = record.sources[record.processedAssets];
      let key = source.key; let head = await env.BUCKET.head(key);
      if (!head && source.fallbackKey) { key = source.fallbackKey; head = await env.BUCKET.head(key); }
      if (!head) throw new SiteBackupError("图片原文件缺失，备份尚未完成：" + source.urls[0]);
      if (head.size > MAX_ASSET_BYTES) throw new SiteBackupError("单张图片超过 8 MiB，无法完成备份");
      const cacheKey = await root(user) + "cache/" + await backupSha256(key) + ".json";
      const cached = await readJson<{ etag: string; uploaded: string; sha256: string; contentType: string; crc32: number }>(env.BUCKET, cacheKey);
      let sha256 = cached?.etag === head.etag && cached.uploaded === head.uploaded.toISOString() ? cached.sha256 : "";
      let contentType = cached?.contentType || "";
      let crc32 = cached?.crc32;
      if (!sha256 || crc32 === undefined || !await env.BUCKET.head(await blobKey(user, sha256))) {
        const object = await env.BUCKET.get(key, { onlyIf: { etagMatches: head.etag } });
        if (!object?.body) throw new SiteBackupError("图片在备份过程中发生变化，请重试");
        const bytes = await object.arrayBuffer();
        contentType = detectImage(new Uint8Array(bytes)) || "";
        if (!contentType || bytes.byteLength !== head.size) throw new SiteBackupError("图片格式或长度不正确，备份已停止");
        sha256 = await backupSha256(bytes);
        crc32 = nativeCrc32(new Uint8Array(bytes));
        await env.BUCKET.put(await blobKey(user, sha256), bytes, { httpMetadata: { contentType }, sha256, customMetadata: { crc32: String(crc32) } });
        await env.BUCKET.put(cacheKey, JSON.stringify({ etag: head.etag, uploaded: head.uploaded.toISOString(), sha256, contentType, crc32 }), { httpMetadata: JSON_HEADERS });
      }
      record.manifest.assets.push({ kind: source.kind, ...(source.purpose ? { purpose: source.purpose } : {}), urls: source.urls, sha256, size: head.size, contentType, crc32: crc32! });
      record.processedAssets++; record.assetCount++; record.assetBytes += head.size;
    }
    if (record.processedAssets === record.totalAssets) record.status = "complete";
    record.failureCount = 0;
  } catch (error) { record.status = "failed"; record.failureCount = (record.failureCount || 0) + 1; record.error = error instanceof Error ? error.message : "备份失败"; }
  await env.assertBackupLease?.();
  await saveRecord(env.BUCKET, user, record); return summary(record);
}

export async function parseArchiveManifest(value: unknown, user: string): Promise<ArchiveManifest> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SiteBackupError("备份清单格式无效");
  const raw = value as Record<string, unknown>;
  if (raw.format !== "yuexiaji-archive" || raw.version !== 1 || typeof raw.createdAt !== "string" || !Number.isFinite(Date.parse(raw.createdAt))) throw new SiteBackupError("不支持的备份包格式或版本");
  if (Object.keys(raw).some((key) => !["format", "version", "createdAt", "data", "dataSha256", "assets", "coverHashes"].includes(key))) throw new SiteBackupError("备份清单包含未知字段");
  const data = parseSiteBackup(raw.data);
  if (raw.dataSha256 !== await siteBackupFingerprint(data)) throw new SiteBackupError("备份数据校验失败");
  if (!Array.isArray(raw.assets) || raw.assets.length > MAX_ASSETS) throw new SiteBackupError("备份图片清单无效");
  const expected = await collectSources(data, user); const expectedUrls = new Map(expected.flatMap((source) => source.urls.map((url) => [url, source] as const)));
  const seen = new Set<string>(); const hashes = new Map<string, { size: number; contentType: string; crc32: number }>();
  const assets: BackupAsset[] = raw.assets.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new SiteBackupError("备份图片条目无效");
    const asset = item as BackupAsset;
    if (Object.keys(asset).some((key) => !["kind", "purpose", "urls", "sha256", "size", "contentType", "crc32"].includes(key)) || !HASH.test(asset.sha256) || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > MAX_ASSET_BYTES || !Number.isInteger(asset.crc32) || asset.crc32 < 0 || asset.crc32 > 0xffffffff || !IMAGE_TYPES.has(asset.contentType) || !Array.isArray(asset.urls) || !asset.urls.length) throw new SiteBackupError("备份图片属性无效");
    for (const url of asset.urls) {
      const source = expectedUrls.get(url);
      if (typeof url !== "string" || !source || seen.has(url) || source.kind !== asset.kind || source.purpose !== asset.purpose) throw new SiteBackupError("备份图片与收藏中的引用不一致");
      seen.add(url);
    }
    const duplicate = hashes.get(asset.sha256);
    if (duplicate && (duplicate.size !== asset.size || duplicate.contentType !== asset.contentType || duplicate.crc32 !== asset.crc32)) throw new SiteBackupError("同一图片的校验值与属性不一致");
    hashes.set(asset.sha256, asset);
    return { kind: asset.kind, ...(asset.purpose ? { purpose: asset.purpose } : {}), urls: [...asset.urls], sha256: asset.sha256, size: asset.size, contentType: asset.contentType, crc32: asset.crc32 };
  });
  if (seen.size !== expectedUrls.size) throw new SiteBackupError("备份包缺少本站图片，不能作为完整备份导入");
  const manifest: ArchiveManifest = { format: "yuexiaji-archive", version: 1, createdAt: raw.createdAt, data, dataSha256: raw.dataSha256 as string, ...(raw.coverHashes === undefined ? {} : { coverHashes: parseCoverHashes(raw.coverHashes, data) }), assets };
  if (encoder.encode(JSON.stringify(manifest)).length > MAX_MANIFEST_BYTES) throw new SiteBackupError("备份数据清单超过 20 MiB");
  return manifest;
}
type UploadRecord = ArchiveRecord & { uploadedHashes?: string[] };
export async function startArchiveUpload(env: BackupEnv, user: string, value: unknown) {
  const manifest = await parseArchiveManifest(value, user);
  const id = "upload-" + await backupSha256(JSON.stringify(manifest));
  let record = await readJson<UploadRecord>(env.BUCKET, await recordKey(user, id));
  const assets = [...new Map(manifest.assets.map((asset) => [asset.sha256, asset])).values()];
  if (!record) {
    record = { id, createdAt: new Date().toISOString(), kind: "uploaded", status: "pending", counts: manifest.data.counts,
      manifest, sources: [], downloadParts: 1, assetCount: assets.length, assetBytes: assets.reduce((sum, asset) => sum + asset.size, 0), processedAssets: 0, totalAssets: assets.length, uploadedHashes: [] };
    for (const asset of assets.slice(0, 300)) {
      await env.assertBackupLease?.();
      const head = await env.BUCKET.head(await blobKey(user, asset.sha256));
      if (head?.size === asset.size && head.httpMetadata?.contentType === asset.contentType && head.customMetadata?.crc32 === String(asset.crc32)) record.uploadedHashes!.push(asset.sha256);
    }
  }
  record.processedAssets = record.uploadedHashes?.length ?? 0;
  if (record.status !== "complete") await saveRecord(env.BUCKET, user, record);
  return { id, backup: summary(record), missingAssets: assets.filter((asset) => !record!.uploadedHashes?.includes(asset.sha256)).map((asset) => asset.sha256) };
}
export async function readLimitedBody(request: Request, maximum: number): Promise<Uint8Array> {
  if (Number(request.headers.get("content-length") || 0) > maximum) throw new SiteBackupError("上传文件超过大小限制", "backup_too_large", 413);
  if (!request.body) throw new SiteBackupError("上传内容为空");
  const chunks: Uint8Array[] = []; const reader = request.body.getReader(); let size = 0;
  try {
    while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > maximum) throw new SiteBackupError("上传文件超过大小限制", "backup_too_large", 413); chunks.push(part.value); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const body = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; } return body;
}
export async function uploadArchiveAsset(env: BackupEnv, user: string, id: string, sha256: string, bytes: Uint8Array) {
  const record = await readRecord(env.BUCKET, user, id) as UploadRecord;
  if (record.kind !== "uploaded" || record.status === "complete") throw new SiteBackupError("该备份不接受图片上传");
  const asset = record.manifest.assets.find((item) => item.sha256 === sha256);
  if (!asset || bytes.length !== asset.size || await backupSha256(bytes) !== sha256 || detectImage(bytes) !== asset.contentType || nativeCrc32(bytes) !== asset.crc32) throw new SiteBackupError("上传图片的大小、格式或 SHA-256 校验失败");
  await env.BUCKET.put(await blobKey(user, sha256), bytes, { httpMetadata: { contentType: asset.contentType }, sha256, customMetadata: { crc32: String(asset.crc32) } });
  record.uploadedHashes = [...new Set([...(record.uploadedHashes || []), sha256])]; record.processedAssets = record.uploadedHashes.length;
  await saveRecord(env.BUCKET, user, record); return summary(record);
}
export async function finishArchiveUpload(env: BackupEnv, user: string, id: string) {
  const record = await readRecord(env.BUCKET, user, id) as UploadRecord;
  if (record.kind !== "uploaded") throw new SiteBackupError("不是离线导入的备份");
  if (record.processedAssets !== record.totalAssets) throw new SiteBackupError("还有图片尚未上传完成");
  record.status = "complete"; await saveRecord(env.BUCKET, user, record); return summary(record);
}
export async function prepareNetdiskZip(bucket: R2Bucket, user: string, archive: string) {
  const record = await readRecord(bucket, user, archive);
  if (record.status !== "complete") throw new Error("备份尚未完成");
  const manifest = encoder.encode(JSON.stringify(record.manifest));
  const { fixed, index } = createZipTemplate(manifest, nativeCrc32(manifest), record.manifest.assets);
  const prefix = await root(user) + "netdisk/" + archive + "/";
  await bucket.put(prefix + "fixed", await fixed.arrayBuffer());
  await bucket.put(prefix + "index", JSON.stringify(index));
  return { prefix, size: index.size };
}

export async function readNetdiskZipBlock(bucket: R2Bucket, user: string, prefix: string, start: number, length: number) {
  const index = await readJson<ZipRangeIndex>(bucket, prefix + "index");
  if (!index || length <= 0 || start < 0 || start + length > index.size) throw new Error("无效的备份区间");
  const end = start + length;
  const output = new Uint8Array(length);
  const gaps: { at: number; length: number }[] = [];
  const reads: { key: string; at: number; offset: number; length: number }[] = [];
  const blobs = await root(user) + "blobs/";
  let position = start, precedingImageBytes = 0;
  for (const image of index.images) {
    if (image.offset >= end) break;
    precedingImageBytes += Math.min(image.size, Math.max(0, start - image.offset));
    const left = Math.max(start, image.offset), right = Math.min(end, image.offset + image.size);
    if (right <= left) continue;
    if (left > position) gaps.push({ at: position - start, length: left - position });
    reads.push({ key: blobs + image.sha256, at: left - start, offset: left - image.offset, length: right - left });
    position = right;
  }
  if (position < end) gaps.push({ at: position - start, length: end - position });
  async function range(key: string, offset: number, length: number) {
    const object = await bucket.get(key, { range: { offset, length } });
    if (!object) throw new Error("备份文件缺失");
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.length !== length) throw new Error("备份区间读取不完整");
    return bytes;
  }
  if (gaps.length) {
    const fixed = await range(prefix + "fixed", start - precedingImageBytes, gaps.reduce((sum, g) => sum + g.length, 0));
    let cursor = 0;
    for (const gap of gaps) { output.set(fixed.subarray(cursor, cursor + gap.length), gap.at); cursor += gap.length; }
  }
  for (let i = 0; i < reads.length; i += 6) {
    await Promise.all(reads.slice(i, i + 6).map(async r => output.set(await range(r.key, r.offset, r.length), r.at)));
  }
  return output;
}

export async function downloadBackupArchive(env: BackupEnv, user: string, id: string, format: string, part = 1): Promise<Response> {
  const record = await readRecord(env.BUCKET, user, id);
  if (record.status !== "complete") throw new SiteBackupError("这份备份尚未完成，不能下载完整备份包");
  const manifest = encoder.encode(JSON.stringify(record.manifest));
  if (format === "json") return new Response(manifest, { headers: { "content-type": "application/json; charset=utf-8", "content-disposition": 'attachment; filename="yuexiaji-' + id + '-data.json"', "cache-control": "no-store" } });
  const allAssets = [...new Map(record.manifest.assets.map((asset) => [asset.sha256, asset])).values()];
  const groups: BackupAsset[][] = [[]];
  for (const asset of allAssets) {
    if (groups[groups.length - 1].length >= ZIP_PART_ASSETS) groups.push([]);
    groups[groups.length - 1].push(asset);
  }
  const parts = groups.length;
  if (!Number.isInteger(part) || part < 1 || part > parts) throw new SiteBackupError("备份分包编号无效");
  const assets = groups[part - 1];
  const suffix = parts > 1 ? "-part-" + String(part).padStart(2, "0") + "-of-" + parts : "";
  async function* entries(): AsyncGenerator<ZipSource> {
    yield { name: "backup.json", size: manifest.length, stream: new Blob([manifest]).stream(), crc32: nativeCrc32(manifest) };
    for (const asset of assets) {
      const object = await env.BUCKET.get(await blobKey(user, asset.sha256));
      if (!object?.body || object.size !== asset.size) throw new Error("备份中的图片缺失，请重新备份");
      yield { name: "assets/" + asset.sha256, size: asset.size, stream: object.body, crc32: asset.crc32 };
    }
  }
  // A browser download part has at most 400 bounded assets, so its headers use ZIP32.
  const entrySize = (name: string, size: number) => size + 30 + 16 + 46 + encoder.encode(name).length * 2;
  const size = 22 + entrySize("backup.json", manifest.length) + assets.reduce((total, asset) => total + entrySize("assets/" + asset.sha256, asset.size), 0);
  return new Response(createBackupZip(entries()), { headers: { "content-type": "application/zip", "content-disposition": 'attachment; filename="yuexiaji-' + id + suffix + '.zip"', "content-length": String(size), "x-backup-parts": String(parts), "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}
export async function previewArchiveRestore(env: BackupEnv, user: string, id: string) {
  const record = await readRecord(env.BUCKET, user, id);
  if (record.status !== "complete") throw new SiteBackupError("备份尚未完成，不能恢复");
  await parseArchiveManifest(record.manifest, user);
  const current = await exportSiteBackup(env.DB, user);
  return { preview: { current: current.counts, incoming: record.manifest.data.counts }, expectedFingerprint: await siteBackupFingerprint(current) };
}
function rewriteUrls(data: SiteBackup, urls: Record<string, string>, backgroundVersion?: number): SiteBackup {
  function visit(value: unknown): unknown {
    if (typeof value === "string") {
      if (Object.hasOwn(urls, value)) return urls[value];
      if (value.startsWith("{") || value.startsWith("[")) { try { const parsed = JSON.parse(value); const next = visit(parsed); const serialized = JSON.stringify(next); return JSON.stringify(parsed) === serialized ? value : serialized; } catch { return value; } }
      return value.split(/(\r\n|\r|\n)/).map((part) => {
        const trimmed = part.trim();
        if (!trimmed || !Object.hasOwn(urls, trimmed)) return part;
        const start = part.indexOf(trimmed);
        return part.slice(0, start) + urls[trimmed] + part.slice(start + trimmed.length);
      }).join("");
    }
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item)]));
    return value;
  }
  const restored = visit(data) as SiteBackup;
  if (backgroundVersion !== undefined) for (const row of restored.tables.user_state) row.background_version = backgroundVersion;
  return parseSiteBackup(restored, true);
}
async function saveRestoreProgress(env: BackupEnv, key: string, progress: RestoreProgress) {
  await env.assertBackupLease?.();
  const stored = await env.BUCKET.put(key, JSON.stringify(progress), { httpMetadata: JSON_HEADERS, onlyIf: progress._etag ? { etagMatches: progress._etag } : { etagDoesNotMatch: "*" } });
  if (!stored) throw new SiteBackupError("恢复进度已由另一项操作更新，请刷新核对", "backup_conflict", 409);
  Object.defineProperty(progress, "_etag", { value: stored.etag, enumerable: false, writable: true });
}
export async function restoreBackupArchive(env: BackupEnv, user: string, id: string, fingerprint: string, preRestoreBackupId?: string) {
  const record = await readRecord(env.BUCKET, user, id);
  if (record.status !== "complete" || !HASH.test(fingerprint)) throw new SiteBackupError("请先预览完整备份后再恢复");
  const current = await exportSiteBackup(env.DB, user);
  const currentHash = await siteBackupFingerprint(current);
  if (!preRestoreBackupId) {
    if (currentHash !== fingerprint) throw new SiteBackupError("预览后数据发生了变化，请重新预览", "backup_conflict", 409);
    const backup = await createBackupArchive(env, user, "before-restore");
    return { needsPreparation: true, backup, preRestoreBackupId: backup.id };
  }
  const safety = await readRecord(env.BUCKET, user, preRestoreBackupId);
  if (safety.kind !== "before-restore" || safety.manifest.dataSha256 !== fingerprint) throw new SiteBackupError("恢复前备份尚未完成或不属于本次操作", "backup_conflict", 409);
  if (safety.status !== "complete") {
    if (currentHash !== fingerprint) throw new SiteBackupError("预览后数据发生了变化，请重新预览", "backup_conflict", 409);
    return { needsPreparation: true, backup: summary(safety), preRestoreBackupId };
  }
  const progressKey = await root(user) + "restores/" + preRestoreBackupId + ".json";
  let progress = await readJson<RestoreProgress>(env.BUCKET, progressKey);
  if (progress && (progress.archiveId !== id || progress.fingerprint !== fingerprint)) throw new SiteBackupError("恢复任务不匹配");
  if (progress?.status === "complete") return { preRestoreBackupId, restored: record.manifest.data.counts };
  if (progress?.status === "committing") {
    const applied = rewriteUrls(record.manifest.data, progress.urls, progress.backgroundVersion);
    if (await siteBackupFingerprint(applied) === currentHash) {
      progress.status = "complete"; await saveRestoreProgress(env, progressKey, progress).catch(() => null);
      return { preRestoreBackupId, restored: applied.counts };
    }
    throw new SiteBackupError("上次恢复没有返回确定结果，请先刷新并核对当前数据；不要重复覆盖", "backup_outcome_unknown", 503, false);
  }
  if (currentHash !== fingerprint) throw new SiteBackupError("预览后数据发生了变化，请重新预览", "backup_conflict", 409);
  if (!progress) progress = { archiveId: id, preRestoreBackupId, fingerprint, processed: 0, urls: {}, status: "preparing" };
  const hash = await backupSha256(user);
  const assets = record.manifest.assets;
  for (let n = 0; n < 8 && progress.processed < assets.length; n++) {
    await env.assertBackupLease?.();
    const asset = assets[progress.processed];
    const object = await env.BUCKET.get(await blobKey(user, asset.sha256));
    if (!object || object.size !== asset.size) throw new SiteBackupError("备份图片缺失，已停止恢复；当前数据未改变");
    const bytes = await object.arrayBuffer();
    if (await backupSha256(bytes) !== asset.sha256 || detectImage(new Uint8Array(bytes)) !== asset.contentType) throw new SiteBackupError("备份图片校验失败，已停止恢复；当前数据未改变");
    let key: string | null = null; let url: string;
    // Equal bytes from distinct original objects must keep distinct gallery URLs.
    const identity = (await backupSha256(JSON.stringify([asset.kind, asset.purpose, [...asset.urls].sort()]))).slice(0, 16);
    const version = "backup-" + asset.sha256 + "-" + identity;
    if (asset.kind === "media") { key = "media-assets/" + hash + "/gallery/" + version; url = "/api/media-assets?v=" + version; }
    else if (asset.kind === "device") { key = "device-assets/" + encodeURIComponent(user) + "/" + asset.purpose + "/" + version; url = "/api/device-assets?purpose=" + asset.purpose + "&v=" + version; }
    else {
      const base = (asset.kind === "avatar" ? "avatars/" : "backgrounds/") + hash;
      const numericVersion = await putVersionedImage(env.BUCKET, base, bytes, asset.contentType, asset.sha256);
      url = "/api/" + asset.kind + "?v=" + numericVersion;
      if (asset.kind === "background") progress.backgroundVersion = numericVersion;
    }
    // Never overwrite a current image: prepare immutable files before the DB transaction.
    if (key) {
      const written = await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: asset.contentType }, sha256: asset.sha256, onlyIf: { etagDoesNotMatch: "*" } });
      if (!written) {
        const previous = await env.BUCKET.get(key);
        if (!previous || await backupSha256(await previous.arrayBuffer()) !== asset.sha256) throw new SiteBackupError("图片恢复目标冲突，当前数据未改变");
      }
    }
    asset.urls.forEach((previous, index) => { progress!.urls[previous] = asset.urls.length > 1 ? url + "&ref=" + index : url; });
    progress.processed++;
  }
  await saveRestoreProgress(env, progressKey, progress);
  if (progress.processed < assets.length) return { needsMore: true, preRestoreBackupId, processedAssets: progress.processed, totalAssets: assets.length };
  const applied = rewriteUrls(record.manifest.data, progress.urls, progress.backgroundVersion);
  const originalHashes = record.manifest.coverHashes ?? await backupCoverHashes(env.DB, user, record.manifest.data);
  const restoredHashes = originalHashes.flatMap(({ image, sourceHash }) => progress.urls[image] ? [{ image: progress.urls[image], sourceHash }] : []);
  progress.status = "committing"; await saveRestoreProgress(env, progressKey, progress);
  try { await env.assertBackupLease?.(); await restoreSiteBackup(env.DB, user, applied, safety.manifest.data, restoredHashes); }
  catch (error) {
    if (error instanceof SiteBackupError && error.rolledBack) { progress.status = "preparing"; await saveRestoreProgress(env, progressKey, progress).catch(() => null); }
    throw error;
  }
  progress.status = "complete";
  // A lost R2 acknowledgement must not turn an already committed restore into a reported rollback.
  await saveRestoreProgress(env, progressKey, progress).catch(() => null);
  return { preRestoreBackupId, restored: applied.counts };
}

async function pruneArchives(env: BackupEnv, user: string, retentionDays: number) {
  const records = await listBackupArchives(env.BUCKET, user);
  const cutoff = Date.now() - retentionDays * 86400000;
  const newest = records.find((item) => item.status === "complete")?.id;
  const kept: ArchiveSummary[] = [];
  for (const item of records) {
    await env.assertBackupLease?.();
    if (item.id !== newest && Date.parse(item.createdAt) < cutoff) {
      await env.BUCKET.delete(await recordKey(user, item.id));
      await env.BUCKET.delete(await root(user) + "restores/" + item.id + ".json");
    } else kept.push(item);
  }
  const referenced = new Set<string>();
  for (const item of kept) for (const asset of (await readRecord(env.BUCKET, user, item.id)).manifest.assets) referenced.add(asset.sha256);
  let cursor: string | undefined; let deleted = 0;
  do {
    const list = await env.BUCKET.list({ prefix: await root(user) + "blobs/", cursor, limit: 1000 });
    const candidates = list.objects.filter((object) => object.uploaded.getTime() < cutoff && !referenced.has(object.key.split("/").pop() || ""));
    await env.assertBackupLease?.();
    if (candidates.length) { await env.BUCKET.delete(candidates.map((item) => item.key)); deleted += candidates.length; }
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor && deleted < 1000);
}
/** Cron wakes every five minutes to resume bounded batches; only one new snapshot is made each day. */
export async function runScheduledBackup(env: BackupEnv, now = new Date()) {
  const user = backupUser(env);
  if (["0", "false", "off"].includes(String(env.BACKUP_COMPONENT_ENABLED).toLowerCase())) return;
  await withBackupLock(env.BUCKET, user, async (assertBackupLease) => {
    env = { ...env, assertBackupLease };
    const errorKey = await root(user) + "last-error.json";
    const lastError = await readJson<{ _etag?: string; error: string | null }>(env.BUCKET, errorKey);
    const reportError = async (error: string | null) => {
      if (error === (lastError?.error ?? null)) return;
      try {
        await assertBackupLease();
        await env.BUCKET.put(errorKey, JSON.stringify({ checkedAt: now.toISOString(), error }), {
          httpMetadata: JSON_HEADERS,
          onlyIf: lastError?._etag ? { etagMatches: lastError._etag } : { etagDoesNotMatch: "*" },
        });
      } catch { /* Error reporting must preserve the actual backup outcome. */ }
    };
    try {
      await runScheduledBackupWithLease(env, user, now);
      await reportError(null);
    } catch (error) {
      // Snapshot validation can fail before a history record exists.
      await reportError(error instanceof Error ? error.message.slice(0, 1000) : "自动备份失败");
      throw error;
    }
  });
}
async function runScheduledBackupWithLease(env: BackupEnv, user: string, now: Date) {
  const settings = await getBackupSettings(env.BUCKET, user);
  const records = await listBackupArchives(env.BUCKET, user);
  let pending = records.find((item) => item.status === "pending" && item.kind !== "uploaded");
  const chinaTime = new Date(now.getTime() + 8 * 3600000);
  const date = chinaTime.toISOString().slice(0, 10);
  const id = "daily-" + date;
  if (!pending && settings.enabled) {
    const failed = records.find((item) => item.id === id && item.status === "failed");
    if (failed && ((await readRecord(env.BUCKET, user, failed.id)).failureCount || 0) < 3) pending = failed;
  }
  // Bootstrap a first real backup without waiting until the next day.
  if (settings.enabled && !pending && !records.some((item) => item.id === id) && (chinaTime.getUTCHours() >= 4 || !records.some((item) => item.kind === "scheduled"))) pending = await createBackupArchive(env, user, "scheduled", id);
  if (pending && pending.status !== "complete") {
    const result = await advanceBackupArchive(env, user, pending.id, 60);
    if (result.status === "failed") throw new Error(result.error || "自动备份失败");
    if (result.status !== "complete") return;
    pending = result;
  }
  if (pending?.status === "complete" || records.some((item) => item.id === id && item.status === "complete")) {
    const maintenanceKey = await root(user) + "maintenance.json";
    const maintenance = await readJson<{ lastPrunedDay: string }>(env.BUCKET, maintenanceKey);
    if (maintenance?.lastPrunedDay !== date) {
      await pruneArchives(env, user, settings.retentionDays);
      await env.BUCKET.put(maintenanceKey, JSON.stringify({ lastPrunedDay: date }), { httpMetadata: JSON_HEADERS });
    }
  }
}

/**
 * 收藏导出 / 导入的纯格式层（可拆组件的一部分）。
 *
 * 适用范围（硬性边界）：
 * - 只导出收藏内容：user_subjects、user_subject_images、media_storage_links。
 * - 绝不导出 admin_account、admin_sessions、admin_auth_logs、bangumi_account、
 *   external_service_credentials、mcp_oauth_*、agent_operations、user_state。
 *   备份文件里出现上述表名或凭据字段时，导入校验直接拒绝。
 * - 本文件不读数据库、不读 Worker 环境、不 import 任何网盘适配器，
 *   所以删掉网盘组件时，导出导入本身不受影响；换网盘时导出格式也不变。
 * - 导出文件不是整站镜像：它只含条目与图片/存储地址引用，
 *   不含 R2 展示图原文件，也不含网盘原图。
 */

export const COLLECTION_BACKUP_FORMAT = "yuexiaji-collection-backup";
export const COLLECTION_BACKUP_VERSION = 1;
export const MAX_BACKUP_SUBJECTS = 20000;
export const MAX_BACKUP_IMAGES_PER_SUBJECT = 60;
export const MAX_BACKUP_LINKS_PER_SUBJECT = 12;

export const MEDIA_TYPES = [
  "anime",
  "movie",
  "tv",
  "game",
  "light_novel",
  "manga",
  "music",
  "visual",
  "video",
] as const;

export type BackupImage = {
  thumbnail: string;
  sourceUrl: string;
  imageHash: string;
  sortOrder: number;
  isCover: boolean;
  width: number | null;
  height: number | null;
  mime: string;
};

export type BackupStorageLink = {
  provider: string;
  label: string;
  url: string;
  path: string;
  isPrimary: boolean;
  note: string;
  state: string;
  operationKey: string;
  objectCount: number | null;
  totalBytes: number | null;
  manifestSha256: string;
  verifiedAtMs: number | null;
};

export type BackupSubject = {
  /** 导出时的内部 id。导入时只作匹配参考，入库后可能被重映射。 */
  id: number;
  type: string;
  subjectId: number | null;
  title: string;
  jp: string;
  note: string;
  progress: number;
  total: number;
  status: string;
  kind: string;
  score: number | null;
  next: string | null;
  image: string | null;
  globalScore: number | null;
  source: string;
  collection: string;
  tags: string[];
  musicAlbum: string;
  musicArtist: string;
  lyricist: string;
  composer: string;
  animeSong: boolean;
  visualSubtype: string;
  videoSubtype: string;
  thumbnail: string;
  sourceUrl: string;
  pixivPid: string;
  author: string;
  twitterSource: string;
  metadata: Record<string, unknown>;
  updatedAtMs: number;
  images: BackupImage[];
  storageLinks: BackupStorageLink[];
};

export type CollectionBackup = {
  format: typeof COLLECTION_BACKUP_FORMAT;
  version: typeof COLLECTION_BACKUP_VERSION;
  exportedAt: string;
  counts: { subjects: number; images: number; storageLinks: number };
  subjects: BackupSubject[];
};

export class CollectionBackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CollectionBackupError";
  }
}

const CREDENTIAL_KEY = /(token|secret|password|credential|api[_-]?key|access[_-]?key|session)/i;
const FORBIDDEN_TABLES = [
  "admin_account",
  "admin_sessions",
  "admin_auth_logs",
  "bangumi_account",
  "external_service_credentials",
  "mcp_oauth_clients",
  "mcp_oauth_codes",
  "mcp_oauth_grants",
  "mcp_oauth_tokens",
  "agent_operations",
  "user_state",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, max: number, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  return value.trim().slice(0, max);
}

function safeInt(value: unknown, fallback: number | null): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function rejectCredentialKeys(value: unknown, where: string, depth = 0): void {
  if (!value || typeof value !== "object" || depth > 4) return;
  for (const [key, candidate] of Object.entries(value as Record<string, unknown>)) {
    if (CREDENTIAL_KEY.test(key)) {
      throw new CollectionBackupError(`${where} 不允许包含凭据字段 ${key}`);
    }
    rejectCredentialKeys(candidate, where, depth + 1);
  }
}

function parseImage(value: unknown, index: number): BackupImage {
  if (!isRecord(value)) throw new CollectionBackupError(`第 ${index + 1} 张画廊图片格式无效`);
  const thumbnail = text(value.thumbnail ?? value.url, 500);
  if (!thumbnail) throw new CollectionBackupError(`第 ${index + 1} 张画廊图片缺少 thumbnail`);
  return {
    thumbnail,
    sourceUrl: text(value.sourceUrl, 1000),
    imageHash: text(value.imageHash, 128),
    sortOrder: safeInt(value.sortOrder, index) ?? index,
    isCover: Boolean(value.isCover),
    width: safeInt(value.width, null),
    height: safeInt(value.height, null),
    mime: text(value.mime ?? value.contentType, 80),
  };
}

function parseStorageLink(value: unknown, index: number): BackupStorageLink {
  if (!isRecord(value)) throw new CollectionBackupError(`第 ${index + 1} 条存储关联格式无效`);
  const provider = text(value.provider, 64);
  if (!provider) throw new CollectionBackupError(`第 ${index + 1} 条存储关联缺少 provider`);
  // 存储关联本身不接受带账号密码的地址，也不接受凭据字段。
  if (value.url && typeof value.url === "string") {
    try {
      const parsed = new URL(value.url);
      if (parsed.username || parsed.password) {
        throw new CollectionBackupError(`第 ${index + 1} 条存储关联地址不能包含账号密码`);
      }
    } catch (error) {
      if (error instanceof CollectionBackupError) throw error;
      // 非绝对地址按空地址处理，后续由存储关联的正规校验再把关；
      // 这里不直接拒绝，避免把历史相对地址误判为非法文件。
    }
  }
  rejectCredentialKeys(value, "存储关联");
  return {
    provider,
    label: text(value.label, 120),
    url: text(value.url, 2000),
    path: text(value.path, 1000),
    isPrimary: Boolean(value.isPrimary),
    note: text(value.note, 1000),
    state: ["linked", "verified", "uncertain", "failed"].includes(String(value.state))
      ? String(value.state)
      : "linked",
    operationKey: text(value.operationKey, 256),
    objectCount: safeInt(value.objectCount, null),
    totalBytes: safeInt(value.totalBytes, null),
    manifestSha256: text(value.manifestSha256, 64),
    verifiedAtMs: value.verifiedAtMs !== undefined && value.verifiedAtMs !== null
      ? safeInt(value.verifiedAtMs, null)
      : value.verifiedAt !== undefined && value.verifiedAt !== null
        ? safeInt(typeof value.verifiedAt === "string" ? Date.parse(value.verifiedAt) : value.verifiedAt, null)
        : null,
  };
}

function parseSubject(value: unknown, index: number): BackupSubject {
  if (!isRecord(value)) throw new CollectionBackupError(`第 ${index + 1} 条收藏格式无效`);
  const type = String(value.type ?? value.mediaType ?? "");
  if (!(MEDIA_TYPES as readonly string[]).includes(type)) {
    throw new CollectionBackupError(`第 ${index + 1} 条收藏类型无效：${type || "（空）"}`);
  }
  const title = text(value.title, 160);
  if (!title) throw new CollectionBackupError(`第 ${index + 1} 条收藏缺少标题`);
  const metadata = isRecord(value.metadata) ? value.metadata : {};
  rejectCredentialKeys(metadata, "收藏 metadata");
  const imagesRaw = Array.isArray(value.images) ? value.images : [];
  const linksRaw = Array.isArray(value.storageLinks) ? value.storageLinks : [];
  if (imagesRaw.length > MAX_BACKUP_IMAGES_PER_SUBJECT) {
    throw new CollectionBackupError(`第 ${index + 1} 条收藏画廊图片超过 ${MAX_BACKUP_IMAGES_PER_SUBJECT} 张`);
  }
  if (linksRaw.length > MAX_BACKUP_LINKS_PER_SUBJECT) {
    throw new CollectionBackupError(`第 ${index + 1} 条收藏存储关联超过 ${MAX_BACKUP_LINKS_PER_SUBJECT} 条`);
  }
  const tags = Array.isArray(value.tags)
    ? value.tags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 30)
    : [];
  return {
    id: safeInt(value.id, 0) ?? 0,
    type,
    subjectId: value.subjectId === null || value.subjectId === undefined
      ? null
      : safeInt(value.subjectId, null),
    title,
    jp: text(value.jp, 160),
    note: text(value.note ?? value.description, 2000),
    progress: safeInt(value.progress, 0) ?? 0,
    total: safeInt(value.total, 12) ?? 12,
    status: text(value.status, 30, "watching") || "watching",
    kind: text(value.kind, 30, "coral") || "coral",
    score: value.score === null || value.score === undefined ? null : safeInt(value.score, null),
    next: value.next === null || value.next === undefined ? null : text(value.next, 120),
    image: value.image === null || value.image === undefined ? null : text(value.image, 500),
    globalScore: value.globalScore === null || value.globalScore === undefined
      ? null
      : Number.isFinite(Number(value.globalScore)) ? Number(value.globalScore) : null,
    source: text(value.source, 30, "manual") || "manual",
    collection: text(value.collection, 120),
    tags,
    musicAlbum: text(value.musicAlbum, 160),
    musicArtist: text(value.musicArtist, 160),
    lyricist: text(value.lyricist, 160),
    composer: text(value.composer, 160),
    animeSong: Boolean(value.animeSong),
    visualSubtype: text(value.visualSubtype, 30),
    videoSubtype: text(value.videoSubtype, 30),
    thumbnail: text(value.thumbnail ?? value.image, 500),
    sourceUrl: text(value.sourceUrl, 1000),
    pixivPid: text(value.pixivPid, 80),
    author: text(value.author, 160),
    twitterSource: text(value.twitterSource, 500),
    metadata,
    updatedAtMs: safeInt(value.updatedAtMs ?? value.updatedAt, Date.now()) ?? Date.now(),
    images: imagesRaw.map((image, imageIndex) => parseImage(image, imageIndex)),
    storageLinks: linksRaw.map((link, linkIndex) => parseStorageLink(link, linkIndex)),
  };
}

/**
 * 校验并规范化一份外部传入的备份文件。
 * 拒绝：格式/版本不对、混入敏感表或凭据字段、条数超限、单条字段非法。
 * 注意：本函数只做格式校验，不做数据库写入，也不做凭据解密。
 */
export function parseCollectionBackup(value: unknown): CollectionBackup {
  if (!isRecord(value)) throw new CollectionBackupError("备份文件必须是 JSON 对象");
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_TABLES.includes(key)) {
      throw new CollectionBackupError(`备份文件不允许包含 ${key}`);
    }
  }
  if (value.format !== COLLECTION_BACKUP_FORMAT) {
    throw new CollectionBackupError("备份文件格式标识不正确");
  }
  if (value.version !== COLLECTION_BACKUP_VERSION) {
    throw new CollectionBackupError(`只支持备份格式版本 ${COLLECTION_BACKUP_VERSION}`);
  }
  if (!Array.isArray(value.subjects)) throw new CollectionBackupError("备份文件缺少 subjects 数组");
  if (value.subjects.length > MAX_BACKUP_SUBJECTS) {
    throw new CollectionBackupError(`备份条目超过 ${MAX_BACKUP_SUBJECTS} 条`);
  }
  const subjects = value.subjects.map((subject, index) => parseSubject(subject, index));
  const counts = {
    subjects: subjects.length,
    images: subjects.reduce((sum, subject) => sum + subject.images.length, 0),
    storageLinks: subjects.reduce((sum, subject) => sum + subject.storageLinks.length, 0),
  };
  if (isRecord(value.counts)) {
    const declared = value.counts;
    if (
      (declared.subjects !== undefined && declared.subjects !== counts.subjects) ||
      (declared.images !== undefined && declared.images !== counts.images) ||
      (declared.storageLinks !== undefined && declared.storageLinks !== counts.storageLinks)
    ) {
      throw new CollectionBackupError("备份文件声明的条数与实际条数不一致");
    }
  }
  return {
    format: COLLECTION_BACKUP_FORMAT,
    version: COLLECTION_BACKUP_VERSION,
    exportedAt: typeof value.exportedAt === "string" && value.exportedAt
      ? value.exportedAt
      : new Date().toISOString(),
    counts,
    subjects,
  };
}

export type ExistingSubjectRef = {
  id: number;
  type: string;
  subjectId: number | null;
  title: string;
};

export type ImportPlanItem = {
  backupId: number;
  /** 命中已存在记录时的库内 id；新增时为 null。 */
  existingId: number | null;
  action: "create" | "update";
  match: "id" | "type-subject-title" | "new";
  title: string;
  type: string;
  images: number;
  storageLinks: number;
};

export type ImportPlan = {
  create: number;
  update: number;
  total: number;
  items: ImportPlanItem[];
};

/**
 * 只做预览，不写库。
 * 匹配顺序：先按导出 id 命中，再按（类型 + 外部 subjectId + 标题）命中，
 * 否则视为新增。这样同一份备份反复导入不会重复建条目，
 * 但 id 已被删、标题又改过的情况会按新增处理，预览里能看出来。
 */
export function planCollectionImport(
  existing: ExistingSubjectRef[],
  backup: CollectionBackup,
): ImportPlan {
  const byId = new Map(existing.map((row) => [row.id, row]));
  const byNaturalKey = new Map(
    existing
      .filter((row) => row.subjectId !== null)
      .map((row) => [`${row.type}:${row.subjectId}:${row.title}`, row]),
  );
  const items: ImportPlanItem[] = backup.subjects.map((subject) => {
    const byIdMatch = subject.id > 0 ? byId.get(subject.id) : undefined;
    if (byIdMatch) {
      return {
        backupId: subject.id, existingId: byIdMatch.id, action: "update",
        match: "id", title: subject.title, type: subject.type,
        images: subject.images.length, storageLinks: subject.storageLinks.length,
      };
    }
    const naturalKey = subject.subjectId !== null
      ? byNaturalKey.get(`${subject.type}:${subject.subjectId}:${subject.title}`)
      : undefined;
    if (naturalKey) {
      return {
        backupId: subject.id, existingId: naturalKey.id, action: "update",
        match: "type-subject-title", title: subject.title, type: subject.type,
        images: subject.images.length, storageLinks: subject.storageLinks.length,
      };
    }
    return {
      backupId: subject.id, existingId: null, action: "create",
      match: "new", title: subject.title, type: subject.type,
      images: subject.images.length, storageLinks: subject.storageLinks.length,
    };
  });
  return {
    create: items.filter((item) => item.action === "create").length,
    update: items.filter((item) => item.action === "update").length,
    total: items.length,
    items,
  };
}

export function collectionBackupFileName(date = new Date()): string {
  const stamp = date.toISOString().slice(0, 10).replace(/-/g, "");
  return `yuexiaji-collection-backup-${stamp}.json`;
}

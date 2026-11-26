/** Browser-only backup transport. Error responses retain recovery information. */
export type BackupCounts = {
  subjects: number;
  images: number;
  storageLinks: number;
  devices: number;
  settings: number;
  schedules: number;
};

export type ArchiveSummary = {
  id: string;
  createdAt: string;
  kind: "manual" | "scheduled" | "before-restore" | "uploaded";
  status: "pending" | "complete" | "failed";
  counts: BackupCounts;
  assetCount: number;
  assetBytes: number;
  processedAssets: number;
  totalAssets: number;
  downloadParts: number;
  error?: string;
};

export type ArchiveSettings = {
  enabled: boolean;
  retentionDays: number;
  scheduleLabel: string;
};

export class BackupApiError extends Error {
  readonly status: number;
  readonly payload: Record<string, unknown>;

  constructor(message: string, status: number, payload: Record<string, unknown>) {
    super(message);
    this.name = "BackupApiError";
    this.status = status;
    this.payload = payload;
  }
}

function responseError(payload: Record<string, unknown>, fallback: string): string {
  if (typeof payload.error === "string" && payload.error) return payload.error;
  if (Array.isArray(payload.errors)) {
    const first = payload.errors.find((entry) => entry && typeof entry === "object" && typeof entry.error === "string");
    if (first) return typeof first.title === "string" && first.title ? `${first.title}：${first.error}` : first.error;
  }
  return fallback;
}

export async function requestBackup(
  path: string,
  init?: RequestInit,
  request: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const response = await request(path, { credentials: "same-origin", ...init });
  const decoded: unknown = await response.json().catch(() => null);
  const payload = decoded && typeof decoded === "object" && !Array.isArray(decoded)
    ? decoded as Record<string, unknown>
    : {};
  if (!response.ok || payload.ok === false || decoded === null || Array.isArray(decoded) || typeof decoded !== "object") {
    const fallback = response.status === 401 ? "登录状态已失效，请重新登录。" : "未收到有效的操作结果，请刷新后核对。";
    throw new BackupApiError(responseError(payload, fallback), response.status, payload);
  }
  return payload;
}

export function backupFailure(error: unknown, operation: "backup" | "import" | "restore" = "backup") {
  const payload = error instanceof BackupApiError ? error.payload : {};
  const preImportBackup = payload.preImportBackup ?? null;
  const preRestoreBackupId = typeof payload.preRestoreBackupId === "string" ? payload.preRestoreBackupId : null;
  const rolledBack = payload.rolledBack === true;
  let message = error instanceof Error ? error.message : "操作未完成，请刷新后核对。";
  if (rolledBack && operation !== "backup") {
    message += ` 本次${operation === "import" ? "导入" : "恢复"}未生效，当前数据已保留。`;
  } else if (operation === "import" && preImportBackup) {
    message += " 导入前快照已保留，请先下载保存并核对当前数据。";
  } else if (operation !== "backup" && (!(error instanceof BackupApiError) || payload.rolledBack === false)) {
    message += " 尚未确认操作结果，请刷新核对当前数据后再决定是否重试。";
  }
  return { message, preImportBackup, preRestoreBackupId, rolledBack };
}

export function archiveFromPayload(payload: Record<string, unknown>): ArchiveSummary {
  const value = payload.backup;
  if (!value || typeof value !== "object") throw new Error("服务器尚未确认备份记录，请刷新列表核对。");
  const backup = value as ArchiveSummary;
  if (typeof backup.id !== "string" || !backup.id || !["pending", "complete", "failed"].includes(backup.status)) {
    throw new Error("服务器返回的备份记录不完整，请刷新列表核对。");
  }
  return backup;
}

/** A failed request is never retried automatically. Pending work can be resumed explicitly. */
export async function completeArchive(
  initial: ArchiveSummary,
  advance: (id: string) => Promise<ArchiveSummary>,
  onProgress: (backup: ArchiveSummary) => void,
  signal?: AbortSignal,
): Promise<ArchiveSummary> {
  let current = initial;
  let unchanged = 0;
  onProgress(current);
  while (current.status === "pending") {
    signal?.throwIfAborted();
    const next = await advance(current.id);
    if (next.id !== initial.id) throw new Error("备份响应与当前任务不一致，已停止处理，请刷新列表核对。");
    if (next.totalAssets !== initial.totalAssets || !Number.isSafeInteger(next.processedAssets)
        || next.processedAssets < current.processedAssets || next.processedAssets > initial.totalAssets) throw new Error("备份进度异常，请刷新核对。");
    unchanged = next.status === "pending" && next.processedAssets <= current.processedAssets ? unchanged + 1 : 0;
    current = next;
    onProgress(current);
    if (unchanged >= 3) throw new Error("备份进度暂未推进，已停止等待，可稍后从列表继续。");
  }
  if (current.status !== "complete") throw new Error(current.error || "备份未完成，请查看记录后重试。");
  return current;
}

export async function completeRestore(
  resumeId: string | undefined,
  request: (beforeId?: string) => Promise<Record<string, unknown>>,
  prepare: (backup: ArchiveSummary) => Promise<void>,
  remember: (id: string) => void,
  onProgress: (processed: number, total: number) => void,
  signal: AbortSignal,
) {
  let beforeId = resumeId;
  let previous = -1;
  let totalAssets: number | undefined;
  let stalled = 0;
  let prepared = false;
  while (true) {
    signal.throwIfAborted();
    const reply = await request(beforeId);
    if (typeof reply.preRestoreBackupId !== "string" || !reply.preRestoreBackupId || (beforeId && reply.preRestoreBackupId !== beforeId)) {
      throw new Error("恢复前备份编号与当前操作不一致，请重新预览。");
    }
    if (!beforeId) remember(reply.preRestoreBackupId);
    beforeId = reply.preRestoreBackupId;
    if (reply.needsPreparation === true) {
      const backup = archiveFromPayload(reply);
      if (prepared || backup.id !== beforeId) throw new Error("未确认恢复前备份，请重新预览。");
      await prepare(backup);
      prepared = true;
    } else if (reply.needsMore === true) {
      const processed = Number(reply.processedAssets);
      const total = Number(reply.totalAssets);
      if (!Number.isSafeInteger(processed) || !Number.isSafeInteger(total) || processed < 0 || processed < previous
          || total <= processed || (totalAssets !== undefined && total !== totalAssets)) throw new Error("恢复进度异常，请重新预览。");
      stalled = processed === previous ? stalled + 1 : 0;
      if (stalled >= 3) throw new Error("恢复进度暂未推进，可重新预览后继续。");
      previous = processed;
      totalAssets = total;
      onProgress(processed, total);
    } else {
      if (reply.ok !== true || !reply.restored) throw new Error("尚未确认恢复完成，请刷新核对。");
      return;
    }
  }
}

export function archiveDownloadUrl(id: string, format: "zip" | "json" = "zip", part?: number): string {
  if (part !== undefined && (!Number.isSafeInteger(part) || part < 1)) throw new Error("备份分包编号无效。");
  return `/api/backup/archive?id=${encodeURIComponent(id)}&format=${format}${part === undefined ? "" : `&part=${part}`}`;
}

export function archiveDownloadLinks(backup: Pick<ArchiveSummary, "id" | "downloadParts">) {
  if (!Number.isSafeInteger(backup.downloadParts) || backup.downloadParts < 1) return [];
  return Array.from({ length: backup.downloadParts }, (_, index) => ({
    part: index + 1,
    href: archiveDownloadUrl(backup.id, "zip", backup.downloadParts > 1 ? index + 1 : undefined),
    label: backup.downloadParts > 1 ? `下载分包 ${index + 1} / ${backup.downloadParts}` : "下载 ZIP",
  }));
}

/** Validate the whole file inventory before creating an uploaded backup record. */
export function validateBackupZipEntries<T extends { name: string; size: number }>(
  manifest: unknown,
  entries: readonly T[],
): Map<string, T> {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("备份清单无效。");
  const value = manifest as Record<string, unknown>;
  if (value.format !== "yuexiaji-archive" || value.version !== 1 || !Array.isArray(value.assets)) {
    throw new Error("请选择月下集导出的完整 ZIP 备份。");
  }
  const expected = new Map<string, number>();
  for (const asset of value.assets) {
    if (!asset || typeof asset !== "object" || typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(asset.sha256)
      || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > 8 * 1024 * 1024) {
      throw new Error("备份图片清单不完整。");
    }
    if (expected.has(asset.sha256) && expected.get(asset.sha256) !== asset.size) throw new Error("备份中相同图片的大小不一致。");
    expected.set(asset.sha256, asset.size);
  }
  const assets = new Map<string, T>();
  let manifests = 0;
  for (const entry of entries) {
    if (entry.name === "backup.json") { manifests += 1; continue; }
    const hash = entry.name.startsWith("assets/") ? entry.name.slice(7) : "";
    if (!expected.has(hash)) throw new Error("备份包包含清单之外的文件。");
    if (assets.has(hash)) throw new Error("备份包包含重复图片文件。");
    if (entry.size !== expected.get(hash)) throw new Error("备份图片大小与清单不一致。");
    assets.set(hash, entry);
  }
  if (manifests !== 1 || assets.size !== expected.size) throw new Error("备份包缺少数据清单或图片文件。");
  return assets;
}

/** Read directories and one manifest at a time; image bytes stay in their original File. */
export async function inspectBackupZipParts<T extends { name: string; size: number }>(
  files: readonly Blob[],
  inspect: (file: Blob) => Promise<T[]>,
  read: (file: Blob, entry: T) => Promise<Blob>,
  signal?: AbortSignal,
) {
  if (!files.length) throw new Error("请选择 ZIP 备份；有多个分包时请同时选择全部文件。");
  let manifestBytes: Uint8Array | null = null;
  let manifest: unknown;
  const combined: Array<{ name: string; size: number; file: Blob; entry: T }> = [];
  for (const file of files) {
    signal?.throwIfAborted();
    const entries = await inspect(file);
    const manifests = entries.filter((entry) => entry.name === "backup.json");
    if (manifests.length !== 1) throw new Error("每个备份分包必须包含一份数据清单。");
    const bytes = new Uint8Array(await (await read(file, manifests[0])).arrayBuffer());
    if (manifestBytes === null) {
      manifestBytes = bytes;
      manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      combined.push({ name: manifests[0].name, size: manifests[0].size, file, entry: manifests[0] });
    } else if (bytes.length !== manifestBytes.length || bytes.some((value, index) => value !== manifestBytes![index])) {
      throw new Error("所选分包的数据清单不一致，请选择同一份备份的全部分包。");
    }
    for (const entry of entries) {
      if (entry.name !== "backup.json") combined.push({ name: entry.name, size: entry.size, file, entry });
    }
  }
  signal?.throwIfAborted();
  const assets = validateBackupZipEntries(manifest, combined);
  return { manifest, assets };
}

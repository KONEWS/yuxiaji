"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  archiveDownloadLinks, archiveFromPayload, backupFailure, completeArchive, inspectBackupZipParts, requestBackup,
  type ArchiveSettings, type ArchiveSummary, type BackupCounts,
} from "../lib/backup-client";
import { inspectBackupZip, readBackupZipEntry } from "../lib/backup-zip";

type ProviderStatus = { id: string; label: string; configured: boolean; ready: boolean; backupStatus?: string; callbackUrl?: string; authorizationExpired?: boolean };
type ImportPlan = { create: number; update: number; total: number };
type RestorePreview = {
  backup: ArchiveSummary; current: BackupCounts; incoming: BackupCounts; expectedFingerprint: string;
};

const countLabels: Array<[keyof BackupCounts, string]> = [
  ["subjects", "收藏"], ["images", "画廊图片"], ["storageLinks", "网盘链接"],
  ["devices", "藏品"], ["settings", "偏好设置"], ["schedules", "日历安排"],
];
const kindLabels: Record<ArchiveSummary["kind"], string> = {
  manual: "手动备份", scheduled: "自动备份", "before-restore": "恢复前备份", uploaded: "上传的备份",
};

function backupDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    hour12: false, timeZone: "Asia/Shanghai",
  }).format(date);
}
function backupSize(bytes: number) {
  if (bytes < 1024) return `${bytes || 0} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
function downloadJson(filename: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function BackupDownloads({ backup, busy, onRefresh }: { backup: ArchiveSummary; busy: boolean; onRefresh: () => void }) {
  const links = archiveDownloadLinks(backup);
  if (!links.length) return <button type="button" className="auth-link" disabled={busy} onClick={onRefresh}>刷新下载信息</button>;
  return <>{links.map((link) => <a className="backup-secondary" key={link.part} href={link.href} download>{link.label}</a>)}</>;
}

/** All writes remain behind the authenticated backup APIs. */
export function BackupPanel() {
  const titleId = useId();
  const previewId = useId();
  const jsonInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);
  const previewRegion = useRef<HTMLDivElement>(null);
  const operation = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const [busyLabel, setBusyLabel] = useState("");
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);
  const [settings, setSettings] = useState<ArchiveSettings | null>(null);
  const [backups, setBackups] = useState<ArchiveSummary[]>([]);
  const [archivesLoaded, setArchivesLoaded] = useState(false);
  const [archiveLoadError, setArchiveLoadError] = useState("");
  const [lastError, setLastError] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [restorePreview, setRestorePreview] = useState<RestorePreview | null>(null);
  const [restoreConfirmed, setRestoreConfirmed] = useState(false);
  const [preRestoreBackupId, setPreRestoreBackupId] = useState<string | null>(null);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [providerMessage, setProviderMessage] = useState("正在读取连接状态…");
  const [baiduAppKey, setBaiduAppKey] = useState("");
  const [baiduSecretKey, setBaiduSecretKey] = useState("");
  const [baiduResult, setBaiduResult] = useState("");
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [backupFile, setBackupFile] = useState<unknown>(null);
  const [importRevision, setImportRevision] = useState<string | null>(null);
  const [preImportBackup, setPreImportBackup] = useState<unknown>(null);
  const busy = Boolean(busyLabel);

  const receiveArchives = useCallback((payload: Record<string, unknown>) => {
    if (!payload.settings || typeof payload.settings !== "object" || !Array.isArray(payload.backups)) {
      throw new Error("未能读取备份列表，请稍后刷新。");
    }
    setSettings(payload.settings as ArchiveSettings);
    setBackups(payload.backups as ArchiveSummary[]);
    setLastError(typeof payload.lastError === "string" ? payload.lastError : "");
    setArchiveLoadError("");
    setArchivesLoaded(true);
  }, []);

  async function refreshArchives(signal?: AbortSignal) {
    const payload = await requestBackup("/api/backup/archives", { cache: "no-store", signal });
    signal?.throwIfAborted();
    receiveArchives(payload);
  }

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void requestBackup("/api/backup/archives", { cache: "no-store", signal: controller.signal })
      .then((payload) => { if (!controller.signal.aborted) receiveArchives(payload); })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setArchiveLoadError(backupFailure(error).message);
        setArchivesLoaded(true);
      });
    void requestBackup("/api/backup/providers", { cache: "no-store", signal: controller.signal })
      .then((payload) => {
        if (controller.signal.aborted) return;
        setProviders(Array.isArray(payload.providers) ? payload.providers as ProviderStatus[] : []);
        setProviderMessage(payload.enabled === false ? "网站网盘连接已关闭。" : "");
        const url = new URL(window.location.href);
        const result = url.searchParams.get("baidu");
        if (result) {
          const messages: Record<string, string> = { success: "百度网盘授权成功，令牌已加密保存。", cancelled: "已取消百度网盘授权。", invalid: "授权已过期、被替换或与当前登录不匹配，请重新发起。", pending_read: "读取或确认本次授权请求失败。", exchange: "服务端未能从百度取得令牌。", invalid_client: "百度拒绝了应用凭据，请核对 AppKey 和 SecretKey。", invalid_grant: "百度拒绝了本次授权码，请重新授权并核对回调地址。", token_response: "百度令牌响应的格式或授权范围与预期不符。", save: "月下集未能加密或保存授权令牌。", failed: "百度网盘授权失败，请检查应用凭据和回调地址后重试。" };
          const actualProviders = Array.isArray(payload.providers) ? payload.providers as ProviderStatus[] : [];
          const confirmed = result !== "success" || actualProviders.some((item) => item.id === "baidu" && item.configured);
          setBaiduResult(confirmed && Object.hasOwn(messages, result) ? messages[result] : "未确认百度网盘授权结果。");
          url.searchParams.delete("baidu");
          window.history.replaceState(window.history.state, "", url);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setProviderMessage("暂时无法读取网盘连接状态。");
      });
    return () => {
      mounted.current = false;
      controller.abort();
      operation.current?.abort();
    };
  }, [receiveArchives]);

  useEffect(() => {
    if (restorePreview) previewRegion.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [restorePreview]);

  function rememberArchive(backup: ArchiveSummary) {
    setBackups((previous) => [backup, ...previous.filter((item) => item.id !== backup.id)]
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)));
  }

  async function runOperation(
    label: string,
    action: (signal: AbortSignal) => Promise<void>,
    context: "backup" | "import" | "restore" = "backup",
  ) {
    if (operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusyLabel(label);
    setIsError(false);
    setMessage(label);
    try {
      await action(controller.signal);
    } catch (error) {
      if (controller.signal.aborted || !mounted.current) return;
      const failure = backupFailure(error, context);
      // Preserve the recovery payload before showing an HTTP error.
      if (failure.preImportBackup) setPreImportBackup(failure.preImportBackup);
      if (failure.preRestoreBackupId) setPreRestoreBackupId(failure.preRestoreBackupId);
      if (context === "import") { setPlan(null); setImportRevision(null); }
      if (context === "restore") {
        setRestorePreview(null);
        setRestoreConfirmed(false);
      }
      setIsError(true);
      setMessage(failure.message);
    } finally {
      if (operation.current === controller) operation.current = null;
      if (mounted.current) setBusyLabel("");
    }
  }

  async function finishArchive(backup: ArchiveSummary, signal: AbortSignal) {
    return completeArchive(backup, async (id) => archiveFromPayload(await requestBackup("/api/backup/archives", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "continue", id }), signal,
    })), rememberArchive, signal);
  }

  function advanceNetdisk() {
    void runOperation("正在检查网盘备份…", async signal => {
      let more: boolean;
      do {
        const step = await requestBackup("/api/backup/providers", { method: "POST", signal });
        const status = await requestBackup("/api/backup/providers", { cache: "no-store", signal });
        const providers = status.providers as ProviderStatus[];
        setProviders(providers);
        setMessage(providers.find(p => p.id === "baidu")?.backupStatus || "网盘状态已刷新");
        more = step.more === true;
      } while (more && !signal.aborted);
    });
  }

  function refreshHistory() {
    void runOperation("正在刷新备份记录…", async (signal) => {
      await refreshArchives(signal);
      setMessage("备份记录已更新。");
    });
  }

  function createArchive() {
    void runOperation("正在创建完整备份…", async (signal) => {
      const initial = archiveFromPayload(await requestBackup("/api/backup/archives", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "create" }), signal,
      }));
      await finishArchive(initial, signal);
      setMessage("完整备份已保存，可在备份记录中下载 ZIP 或预览恢复。");
    });
  }

  function resumeArchive(backup: ArchiveSummary) {
    void runOperation("正在继续备份…", async (signal) => {
      const resumed = backup.status === "failed" ? archiveFromPayload(await requestBackup("/api/backup/archives", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "continue", id: backup.id }), signal,
      })) : backup;
      await finishArchive(resumed, signal);
      setMessage("完整备份已保存，可下载 ZIP。");
    });
  }

  function uploadArchive(files: File[]) {
    void runOperation("正在检查完整备份文件…", async (signal) => {
      const { manifest, assets } = await inspectBackupZipParts(files, inspectBackupZip, readBackupZipEntry, signal);
      signal.throwIfAborted();
      const started = await requestBackup("/api/backup/archive", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "upload-start", manifest }), signal,
      });
      const backup = archiveFromPayload(started);
      rememberArchive(backup);
      if (!Array.isArray(started.missingAssets) || started.missingAssets.some((hash) => typeof hash !== "string" || !assets.has(hash))) {
        throw new Error("服务器返回的待上传图片清单不完整，请刷新核对。");
      }
      const missing = [...new Set(started.missingAssets as string[])];
      for (let index = 0; index < missing.length; index += 1) {
        signal.throwIfAborted();
        const hash = missing[index];
        const source = assets.get(hash)!;
        setMessage(`正在上传备份图片 ${index + 1} / ${missing.length}，请保持页面打开…`);
        const image = await readBackupZipEntry(source.file, source.entry);
        const payload = await requestBackup(`/api/backup/archive?id=${encodeURIComponent(backup.id)}&sha256=${encodeURIComponent(hash)}`, {
          method: "PUT", headers: { "content-type": "application/octet-stream" }, body: image, signal,
        });
        rememberArchive(archiveFromPayload(payload));
      }
      const completed = archiveFromPayload(await requestBackup("/api/backup/archive", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "upload-finish", id: backup.id }), signal,
      }));
      rememberArchive(completed);
      if (completed.status !== "complete") throw new Error("备份尚未上传完整，请重新选择这份备份的全部 ZIP 文件继续。");
      setMessage("备份文件已上传并校验，当前数据尚未改变。可在记录中选择预览恢复。");
    });
  }

  function configureArchives(enabled: boolean, retentionDays: number) {
    void runOperation("正在保存自动备份设置…", async (signal) => {
      const payload = await requestBackup("/api/backup/archives", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "configure", enabled, retentionDays }), signal,
      });
      if (!payload.settings || typeof payload.settings !== "object") throw new Error("未确认设置已保存，请刷新核对。");
      const updated = payload.settings as ArchiveSettings;
      setSettings(updated);
      setMessage(updated.enabled
        ? `自动备份已开启：${updated.scheduleLabel}，保留 ${updated.retentionDays} 天。`
        : "自动备份已关闭，已有备份仍可下载和恢复。");
    });
  }

  function previewRestore(backup: ArchiveSummary) {
    if (operation.current) return;
    setRestorePreview(null);
    setRestoreConfirmed(false);
    void runOperation("正在核对备份与当前数据…", async (signal) => {
      const payload = await requestBackup("/api/backup/archive", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "preview", id: backup.id }), signal,
      });
      if (!payload.preview || typeof payload.preview !== "object" || typeof payload.expectedFingerprint !== "string") {
        throw new Error("恢复预览不完整，请刷新后重试。");
      }
      const preview = payload.preview as { current: BackupCounts; incoming: BackupCounts };
      setRestorePreview({ backup, ...preview, expectedFingerprint: payload.expectedFingerprint });
      setMessage("恢复预览已就绪，当前数据尚未改变。");
    });
  }

  function restoreArchive() {
    if (!restorePreview || !restoreConfirmed || operation.current) return;
    const selected = restorePreview;
    setPreRestoreBackupId(null);
    void runOperation("正在准备恢复，并保存恢复前备份…", async (signal) => {
      const body = {
        action: "restore", id: selected.backup.id, confirmed: true,
        expectedFingerprint: selected.expectedFingerprint,
      };
      const restoreRequest = (preRestoreId?: string) => requestBackup("/api/backup/archive", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, ...(preRestoreId ? { preRestoreBackupId: preRestoreId } : {}) }), signal,
      });
      let payload = await restoreRequest();
      let beforeId = typeof payload.preRestoreBackupId === "string" ? payload.preRestoreBackupId : undefined;
      if (beforeId) setPreRestoreBackupId(beforeId);
      if (payload.needsPreparation === true) {
        const before = archiveFromPayload(payload);
        await finishArchive(before, signal);
        beforeId = before.id;
        setPreRestoreBackupId(beforeId);
        setMessage("恢复前备份已保存，正在准备恢复图片…");
        payload = await restoreRequest(beforeId);
      }
      let previousProgress = -1;
      let unchanged = 0;
      let steps = 0;
      while (payload.needsMore === true) {
        signal.throwIfAborted();
        if (!beforeId) throw new Error("未确认恢复前备份，已停止操作，请刷新核对。");
        const processed = Number(payload.processedAssets);
        const total = Number(payload.totalAssets);
        if (!Number.isSafeInteger(processed) || !Number.isSafeInteger(total) || processed < 0 || total < processed) {
          throw new Error("恢复进度异常，已停止操作，请刷新核对。");
        }
        unchanged = processed <= previousProgress ? unchanged + 1 : 0;
        if (unchanged >= 3 || steps >= 2000) throw new Error("恢复进度暂未推进，已停止等待，请刷新核对后重新预览。");
        previousProgress = processed;
        setMessage(`正在准备恢复图片 ${processed} / ${total}，当前数据尚未替换…`);
        payload = await restoreRequest(beforeId);
        steps += 1;
      }
      if (payload.needsPreparation === true || payload.ok !== true) throw new Error("尚未确认恢复完成，请刷新核对。");
      setRestorePreview(null);
      setRestoreConfirmed(false);
      setMessage("恢复完成，正在刷新月下集…");
      // Discard stale in-memory collection and preference state after replacement.
      window.location.reload();
    }, "restore");
  }

  function exportCollection() {
    void runOperation("正在导出收藏数据…", async (signal) => {
      const payload = await requestBackup("/api/backup/export", { cache: "no-store", signal });
      if (payload.format !== "yuexiaji-collection-backup" || payload.version !== 1 || !Array.isArray(payload.subjects)) {
        throw new Error("未收到有效的收藏备份文件，请刷新后重试。");
      }
      downloadJson(`yuexiaji-collection-${new Date().toISOString().slice(0, 10)}.json`, payload);
      setMessage("已开始下载收藏 JSON，仅含收藏数据和图片地址，不含图片文件。");
    });
  }

  function previewImport(file: File) {
    if (operation.current) return;
    setPlan(null);
    setBackupFile(null);
    setImportRevision(null);
    void runOperation("正在校验收藏文件…", async (signal) => {
      if (file.size > 20 * 1024 * 1024) throw new Error("收藏文件超过 20 MB，请选择较小的备份。");
      const parsed: unknown = JSON.parse(await file.text());
      const payload = await requestBackup("/api/backup/import", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "preview", backup: parsed }), signal,
      });
      if (!payload.plan || typeof payload.plan !== "object" || typeof payload.revision !== "string") throw new Error("未能生成完整的导入预览，请刷新后重试。");
      setBackupFile(parsed);
      setPlan(payload.plan as ImportPlan);
      setImportRevision(payload.revision);
      setMessage("导入预览已就绪，当前收藏尚未改变。");
    });
  }

  function importCollection() {
    if (!backupFile || !plan || !importRevision || operation.current) return;
    if (!window.confirm(`确认合并收藏吗？将新增 ${plan.create} 条、更新 ${plan.update} 条，保留备份中没有的现有收藏。此文件不包含图片原文件。`)) return;
    setPreImportBackup(null);
    void runOperation("正在合并收藏…", async (signal) => {
      const payload = await requestBackup("/api/backup/import", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "import", confirmed: true, backup: backupFile, expectedRevision: importRevision }), signal,
      });
      if (payload.preImportBackup) setPreImportBackup(payload.preImportBackup);
      if (Array.isArray(payload.errors) && payload.errors.length) throw new Error("导入结果包含错误，请先保存导入前快照并核对收藏。");
      setPlan(null);
      setBackupFile(null);
      setImportRevision(null);
      const skipped = typeof payload.skippedLinks === "number" ? payload.skippedLinks : 0;
      setMessage(`收藏合并完成：新增 ${String(payload.created ?? 0)} 条，更新 ${String(payload.updated ?? 0)} 条。${skipped ? `跳过 ${skipped} 条无效网盘链接。` : ""}重新打开月下集后可查看更新。`);
    }, "import");
  }

  function authorizeBaidu(reuse: boolean) {
    setBaiduResult("");
    void runOperation("正在打开百度网盘授权…", async (signal) => {
      const payload = await requestBackup("/api/backup/providers/baidu", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(reuse ? { reuse: true } : { appKey: baiduAppKey.trim(), secretKey: baiduSecretKey.trim() }), signal,
      });
      const url = new URL(String(payload.authorizationUrl ?? ""));
      if (url.origin !== "https://openapi.baidu.com" || url.pathname !== "/oauth/2.0/authorize") throw new Error("未收到有效的百度授权地址。");
      setBaiduSecretKey("");
      window.location.assign(url.href);
    });
  }

  function disconnectProvider(provider: ProviderStatus) {
    if (!window.confirm(`确认解绑 ${provider.label} 吗？将移除网站中的连接配置，保留网盘文件和现有收藏。`)) return;
    void runOperation("正在解绑网盘…", async (signal) => {
      await requestBackup("/api/backup/providers", {
        method: "DELETE", headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: provider.id }), signal,
      });
      const payload = await requestBackup("/api/backup/providers", { cache: "no-store", signal });
      setProviders(Array.isArray(payload.providers) ? payload.providers as ProviderStatus[] : []);
      if (provider.id === "baidu") { setBaiduResult(""); setBaiduAppKey(""); setBaiduSecretKey(""); }
      setMessage(`${provider.label} 已解绑。`);
    });
  }

  const visibleBackups = showAll ? backups : backups.slice(0, 5);
  const beforeRestore = backups.find((backup) => backup.id === preRestoreBackupId);
  return (
    <section className="security-card integration-card backup-panel" aria-labelledby={titleId}>
      <div className="security-card-title backup-heading">
        <div><h2 id={titleId}>备份与恢复</h2><p>保存完整副本，也能单独迁移收藏。</p></div>
        <span className={settings?.enabled ? "enabled" : ""}>
          {settings ? settings.enabled ? "自动备份已开启" : "手动备份" : archivesLoaded ? "状态未确认" : "读取中"}
        </span>
      </div>

      <div className="backup-section backup-primary-section">
        <div className="backup-section-heading"><h3>完整备份</h3><span className="backup-label">数据与本站图片</span></div>
        <p>包含收藏、藏品、偏好设置、日历和本站保存的图片。外部图片和网盘内容保留地址，文件仍由原服务保存。</p>
        <div className="backup-actions">
          <button type="button" className="auth-primary" disabled={busy || !settings} onClick={createArchive}>创建完整备份</button>
          <button type="button" className="backup-secondary" disabled={busy || !settings} onClick={() => zipInput.current?.click()}>上传 ZIP 备份</button>
          <button type="button" className="auth-link" disabled={busy} onClick={refreshHistory}>刷新记录</button>
          <input ref={zipInput} type="file" accept="application/zip,.zip" multiple hidden disabled={busy} aria-label="选择完整备份的全部 ZIP 文件"
            onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ""; if (files.length) uploadArchive(files); }} />
        </div>
        <p className="backup-small-note">备份保存后可下载 ZIP 离线留存；有多个分包时，恢复时同时选择全部分包。上传文件只添加备份记录，预览并确认后才会恢复。</p>
        {archiveLoadError && <p className="backup-notice" data-tone="error">{archiveLoadError}</p>}
      </div>

      {message && <p className="backup-notice backup-operation-message" data-tone={isError ? "error" : busy ? "progress" : "success"} role="status" aria-live="polite">{message}</p>}

      {settings && (
        <div className="backup-schedule">
          <div className="backup-schedule-copy"><b>自动备份</b><span>{settings.scheduleLabel}</span></div>
          <button type="button" className="backup-switch" role="switch" aria-checked={settings.enabled}
            aria-label="自动备份" disabled={busy}
            onClick={() => configureArchives(!settings.enabled, settings.retentionDays)}><span /></button>
          <label className="backup-retention">保留时间
            <select disabled={busy} value={settings.retentionDays}
              onChange={(event) => configureArchives(settings.enabled, Number(event.target.value))}>
              <option value={7}>7 天</option><option value={14}>14 天</option><option value={30}>30 天</option>
            </select>
          </label>
          {lastError && <p className="backup-notice" data-tone="error">最近一次自动备份未完成：{lastError}</p>}
        </div>
      )}

      <div className="backup-section">
        <div className="backup-section-heading"><h3>备份记录</h3><span className="backup-meta">北京时间</span></div>
        {!archivesLoaded && <p className="backup-empty">正在读取备份记录…</p>}
        {archivesLoaded && !archiveLoadError && backups.length === 0 && <p className="backup-empty">还没有完整备份，创建一份即可在这里下载和恢复。</p>}
        <div className="backup-history">
          {visibleBackups.map((backup) => (
            <article className="backup-history-row" key={backup.id}>
              <div className="backup-history-copy">
                <div className="backup-history-title"><b>{backupDate(backup.createdAt)}</b>
                  <span className="backup-status" data-status={backup.status}>{backup.status === "complete" ? "已完成" : backup.status === "failed" ? "未完成" : "待继续"}</span></div>
                <p>{kindLabels[backup.kind] ?? "备份"} · {backup.counts.subjects} 条收藏 · {backup.counts.devices} 件藏品 · {backup.assetCount} 张本站图片 · {backupSize(backup.assetBytes)}</p>
                {backup.status === "complete" && backup.downloadParts > 1 && <p>共 {backup.downloadParts} 个 ZIP 分包，恢复时同时选择全部分包。</p>}
                {backup.status === "pending" && <div className="backup-progress">
                  <progress value={backup.processedAssets} max={Math.max(1, backup.totalAssets)} aria-label="备份图片进度" />
                  <span>{backup.processedAssets} / {backup.totalAssets} 张图片</span>
                </div>}
                {backup.error && <p className="backup-notice" data-tone="error">{backup.error}</p>}
              </div>
              <div className="backup-row-actions" style={backup.downloadParts > 1 ? { gridColumn: "1 / -1", justifyContent: "flex-start" } : undefined}>
                {backup.status === "complete" && <>
                  <BackupDownloads backup={backup} busy={busy} onRefresh={refreshHistory} />
                  <button type="button" className="auth-link" disabled={busy} onClick={() => previewRestore(backup)}>预览恢复</button>
                </>}
                {backup.status !== "complete" && <button type="button" className="backup-secondary" disabled={busy}
                  onClick={() => backup.kind === "uploaded" ? zipInput.current?.click() : resumeArchive(backup)}>
                  {backup.kind === "uploaded" ? "重新选择 ZIP 继续" : backup.status === "failed" ? "重试备份" : "继续备份"}
                </button>}
              </div>
            </article>
          ))}
        </div>
        {backups.length > 5 && <button type="button" className="auth-link backup-show-all" onClick={() => setShowAll(!showAll)}>
          {showAll ? "收起记录" : `查看全部 ${backups.length} 份备份`}
        </button>}
      </div>

      {restorePreview && <div className="backup-restore-preview" ref={previewRegion} role="region" aria-labelledby={previewId}>
        <div className="backup-section-heading"><h3 id={previewId}>恢复这份备份</h3><span className="backup-meta">{backupDate(restorePreview.backup.createdAt)}</span></div>
        <p>恢复会以备份内容替换当前收藏、藏品、偏好和日历。当前有、备份中没有的记录会被删除；开始前会先保存当前完整备份。</p>
        <table className="backup-comparison"><thead><tr><th scope="col">内容</th><th scope="col">当前</th><th scope="col">恢复后</th></tr></thead>
          <tbody>{countLabels.map(([key, label]) => <tr key={key}><th scope="row">{label}</th><td>{restorePreview.current[key]}</td><td>{restorePreview.incoming[key]}</td></tr>)}</tbody>
        </table>
        <label className="backup-confirm"><input type="checkbox" checked={restoreConfirmed} disabled={busy}
          onChange={(event) => setRestoreConfirmed(event.target.checked)} />
          <span>我确认替换当前数据，并删除备份中不存在的记录。</span>
        </label>
        <div className="backup-actions">
          <button type="button" className="auth-primary backup-restore-button" disabled={busy || !restoreConfirmed} onClick={restoreArchive}>确认恢复</button>
          <button type="button" className="backup-secondary" disabled={busy} onClick={() => { setRestorePreview(null); setRestoreConfirmed(false); }}>取消</button>
        </div>
      </div>}

      {preRestoreBackupId && <div className="backup-recovery-note"><p>恢复前备份已保留，可在记录中查看完成状态。</p>
        {beforeRestore?.status === "complete" && <div className="backup-row-actions">
          {beforeRestore.downloadParts > 1 && <p>恢复前备份共 {beforeRestore.downloadParts} 个分包，请全部保存。</p>}
          <BackupDownloads backup={beforeRestore} busy={busy} onRefresh={refreshHistory} />
        </div>}
        {!beforeRestore && <button type="button" className="auth-link" disabled={busy} onClick={refreshHistory}>刷新备份记录</button>}
      </div>}

      <details className="backup-details">
        <summary><span>仅收藏数据</span><small>JSON 导出与合并导入</small></summary>
        <div className="backup-details-body">
          <p>仅包含收藏、画廊图片地址和网盘链接。合并导入会新增或更新收藏，保留文件中没有的现有条目；不含图片文件、藏品和偏好设置。</p>
          <div className="backup-actions">
            <button type="button" className="backup-secondary" disabled={busy} onClick={exportCollection}>导出收藏 JSON</button>
            <button type="button" className="backup-secondary" disabled={busy} onClick={() => jsonInput.current?.click()}>选择 JSON 导入</button>
            <input ref={jsonInput} type="file" accept="application/json,.json" hidden disabled={busy} aria-label="选择收藏备份文件"
              onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) previewImport(file); }} />
          </div>
          {plan && <div className="backup-recovery-note"><p>将新增 {plan.create} 条、更新 {plan.update} 条，共 {plan.total} 条收藏。</p>
            <button type="button" className="auth-primary" disabled={busy} onClick={importCollection}>确认合并导入</button>
          </div>}
        </div>
      </details>

      {Boolean(preImportBackup) && <div className="backup-recovery-note"><p>导入前收藏快照已保留，仅包含收藏数据和图片地址。</p>
        <button type="button" className="auth-link" onClick={() => downloadJson("yuexiaji-collection-before-import.json", preImportBackup)}>下载导入前快照</button>
      </div>}

      <details className="backup-details" id="backup-cloud" open>
        <summary><span>网盘连接</span><small>授权与连接状态</small></summary>
        <div className="backup-details-body">
          <p>本站完整备份与网盘中的原图归档分别保存。</p>
          {providerMessage && <p>{providerMessage}</p>}
          {!providerMessage && providers.length === 0 && <p>暂无可用的网盘连接。</p>}
          {baiduResult && <p className="backup-small-note" role="status">{baiduResult}</p>}
          {providers.map((provider) => <div key={provider.id} className="backup-details-body">
            <div className="backup-provider">
              <b>{provider.label}</b><span>{provider.id === "baidu" ? provider.configured ? provider.authorizationExpired ? "授权已过期" : "已授权" : "未授权" : provider.configured ? "已连接" : "未连接"}</span>
              {provider.backupStatus && <span>{provider.backupStatus}</span>}
              {provider.configured && <button type="button" className="auth-link" disabled={busy} onClick={() => disconnectProvider(provider)}>解绑</button>}
            </div>
            {provider.id === "baidu" && provider.callbackUrl && <>
              <p>首次连接请在 <a className="auth-link" href="https://pan.baidu.com/union" target="_blank" rel="noopener noreferrer">百度网盘开放平台</a> 创建应用，将下方地址填入应用的 OAuth 回调地址。</p>
              <label>OAuth 回调地址<input readOnly value={provider.callbackUrl} onFocus={(event) => event.target.select()} /></label>
              {provider.configured && <div className="backup-actions"><button type="button" className="backup-secondary" disabled={busy || !settings?.enabled} onClick={advanceNetdisk}>执行到期网盘备份</button><button type="button" className="auth-primary" disabled={busy} onClick={() => authorizeBaidu(true)}>重新授权</button></div>}
              <div className="security-form-row">
                <label>AppKey<input value={baiduAppKey} maxLength={256} autoComplete="off" placeholder="百度应用 AppKey" disabled={busy} onChange={(event) => setBaiduAppKey(event.target.value)} /></label>
                <label>SecretKey<input type="password" value={baiduSecretKey} maxLength={256} autoComplete="off" placeholder="百度应用 SecretKey" disabled={busy} onChange={(event) => setBaiduSecretKey(event.target.value)} /></label>
              </div>
              <div className="backup-actions"><button type="button" className="auth-primary" disabled={busy || !baiduAppKey.trim() || !baiduSecretKey.trim()} onClick={() => authorizeBaidu(false)}>{provider.configured ? "更换应用并授权" : "授权百度网盘"}</button></div>
              <p className="backup-small-note">在百度官方页面完成登录和授权后自动返回。开启自动备份后，每 5 天保存一份完整 ZIP 到百度网盘「我的应用数据／备份／月下集备份」。</p>
            </>}
          </div>)}
        </div>
      </details>
    </section>
  );
}

"use client";

/**
 * 备份组件的唯一界面入口（可拆）。
 * 只调用 /api/backup/*，不 import 媒体、状态、账户逻辑。
 * 去除方法：删掉本文件，并在 security-panel.tsx 里删掉
 * 标注为“备份组件挂载点”的一行，核心不受影响。
 * 网盘上传在 v1 尚未接通：面板只展示 provider 状态，
 * 百度上传按钮会明确提示尚未接通，不会假装上传成功。
 */

import { useEffect, useState } from "react";

type ProviderStatus = {
  id: string;
  label: string;
  kind: string;
  configured: boolean;
  source: string | null;
  lastVerifiedAt: string | null;
  updatedAt: string | null;
  ready: boolean;
  notReadyReason: string | null;
};

type ImportPlan = {
  create: number;
  update: number;
  total: number;
  items: Array<{ title: string; type: string; action: string; match: string }>;
};

async function apiRequest(path: string, init?: RequestInit) {
  const response = await fetch(path, init);
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(typeof payload.error === "string" ? payload.error : "请求失败");
  }
  return payload;
}

function downloadJson(filename: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function BackupPanel() {
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [providersEnabled, setProvidersEnabled] = useState(true);
  const [message, setMessage] = useState("");
  const [isError, setIsError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [backupFile, setBackupFile] = useState<unknown>(null);
  const [preImportBackup, setPreImportBackup] = useState<unknown>(null);

  useEffect(() => {
    apiRequest("/api/backup/providers", { cache: "no-store" })
      .then((payload) => {
        setProvidersEnabled(Boolean(payload.enabled));
        setProviders(Array.isArray(payload.providers) ? (payload.providers as ProviderStatus[]) : []);
      })
      .catch(() => {
        setProvidersEnabled(false);
      });
  }, []);

  async function exportBackup() {
    setBusy(true);
    setIsError(false);
    setMessage("正在导出…");
    try {
      const response = await fetch("/api/backup/export", { cache: "no-store" });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
        throw new Error(typeof payload.error === "string" ? payload.error : "导出失败");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `yuexiaji-collection-backup-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setMessage("导出完成，文件已下载。导出的只有收藏内容，不含密码、会话和各类 Token。");
    } catch (error) {
      setIsError(true);
      setMessage(error instanceof Error ? error.message : "导出失败");
    } finally {
      setBusy(false);
    }
  }

  async function previewImport(file: File) {
    setBusy(true);
    setIsError(false);
    setMessage("正在校验备份文件…");
    setPlan(null);
    setPreImportBackup(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      setBackupFile(parsed);
      const payload = await apiRequest("/api/backup/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "preview", backup: parsed }),
      });
      setPlan(payload.plan as ImportPlan);
      setMessage("预览完成，尚未写入任何数据。确认无误后再点导入。");
    } catch (error) {
      setIsError(true);
      setMessage(error instanceof Error ? error.message : "预览失败");
    } finally {
      setBusy(false);
    }
  }

  async function importBackup() {
    if (!backupFile || !plan) return;
    if (!window.confirm(`确认导入吗？将新增 ${plan.create} 条、更新 ${plan.update} 条，不会因为备份里没有某条就删除库内记录。导入前会自动算出当前数据的快照，导入完成后会提供下载。`)) return;
    setBusy(true);
    setIsError(false);
    setMessage("正在导入…");
    try {
      const payload = await apiRequest("/api/backup/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "import", confirmed: true, backup: backupFile }),
      });
      setPreImportBackup(payload.preImportBackup ?? null);
      const skipped = typeof payload.skippedLinks === "number" ? payload.skippedLinks : 0;
      const failed = Array.isArray(payload.errors) ? payload.errors.length : 0;
      setMessage(
        `导入完成：新增 ${String(payload.created ?? 0)} 条，更新 ${String(payload.updated ?? 0)} 条` +
        (skipped ? `，跳过 ${skipped} 条无效存储关联` : "") +
        (failed ? `，${failed} 条在中途失败，已停止写入，请先下载导入前快照再处理` : "。"),
      );
      if (failed) setIsError(true);
    } catch (error) {
      setIsError(true);
      setMessage(error instanceof Error ? error.message : "导入失败");
    } finally {
      setBusy(false);
    }
  }

  async function disconnectProvider(id: string, label: string) {
    if (!window.confirm(`确认解绑 ${label} 吗？只删除它的网站侧配置，不删除收藏，也不删除网盘上已有的备份文件。`)) return;
    setBusy(true);
    try {
      await apiRequest("/api/backup/providers", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: id }),
      });
      const refreshed = await apiRequest("/api/backup/providers", { cache: "no-store" });
      setProviders(Array.isArray(refreshed.providers) ? (refreshed.providers as ProviderStatus[]) : []);
      setMessage(`${label} 已解绑`);
      setIsError(false);
    } catch (error) {
      setIsError(true);
      setMessage(error instanceof Error ? error.message : "解绑失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="security-card integration-card">
      <div className="security-card-title">
        <div><h2>收藏备份</h2><p>导出导入与网盘组件</p></div>
        <span>{providersEnabled ? "已启用" : "已关闭"}</span>
      </div>
      <p>
        导出文件只含收藏条目、画廊图片与存储关联，不含管理员密码、会话、
        Bangumi 与外部 Token。导入默认合并，不自动删除库内已有记录。
        MEGA 继续走东京服务器 rclone，不在网站登录。
      </p>
      <div className="security-inline-actions">
        <button className="auth-primary" disabled={busy} onClick={exportBackup}>
          {busy ? "处理中…" : "导出收藏 JSON"}
        </button>
        <label className="auth-link">
          选择备份文件导入
          <input
            type="file"
            accept="application/json,.json"
            style={{ display: "none" }}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void previewImport(file);
              event.target.value = "";
            }}
          />
        </label>
      </div>
      {plan && (
        <div className="bangumi-binding-status">
          <span>预览：新增 {plan.create} 条，更新 {plan.update} 条，共 {plan.total} 条</span>
          <button className="auth-primary" disabled={busy} onClick={importBackup}>
            {busy ? "导入中…" : "确认导入"}
          </button>
        </div>
      )}
      {Boolean(preImportBackup) && (
        <div className="bangumi-binding-status">
          <span>导入前快照已生成，导入后如需回滚请先下载保存。</span>
          <button
            className="auth-link"
            onClick={() => downloadJson("yuexiaji-collection-backup-before-import.json", preImportBackup)}
          >
            下载导入前快照
          </button>
        </div>
      )}
      <h3>网盘</h3>
      {providers.length === 0 && <p>暂无可用的网站侧网盘适配器，或备份组件已关闭。</p>}
      {providers.map((provider) => (
        <div className="bangumi-binding-status" key={provider.id}>
          <b>{provider.label}</b>
          <span>{provider.configured ? "已配置" : "未配置"}</span>
          <span>{provider.ready ? "可上传" : (provider.notReadyReason ?? "尚未接通")}</span>
          {provider.configured && (
            <button className="auth-link" disabled={busy} onClick={() => disconnectProvider(provider.id, provider.label)}>
              解绑
            </button>
          )}
        </div>
      ))}
      {message && <p className={`bangumi-binding-message ${isError ? "error" : "success"}`} role="status" aria-live="polite">{message}</p>}
    </section>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Binding = {
  bangumiUserId: number;
  username: string;
  lastSyncAt: string | null;
  createdAt: string;
  updatedAt: string;
};

function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleString("zh-CN") : "尚未同步";
}

export default function BangumiSettingsPage() {
  const router = useRouter();
  const [account, setAccount] = useState<Binding | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    const response = await fetch("/api/bangumi/account", { cache: "no-store" });
    if (response.status === 401) {
      router.replace("/login");
      return;
    }
    const payload = await response.json().catch(() => ({})) as { account?: Binding | null; error?: string };
    if (!response.ok) throw new Error(payload.error || "无法读取 Bangumi 绑定状态");
    setAccount(payload.account || null);
  }, [router]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load().catch((error) => setMessage(error instanceof Error ? error.message : "无法读取绑定状态"));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function request(path: string, init?: RequestInit) {
    const response = await fetch(path, init);
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      const error = typeof payload.error === "string" ? payload.error : "请求失败";
      const details = typeof payload.details === "string" ? payload.details : "";
      throw new Error([error, details].filter(Boolean).join("："));
    }
    return payload;
  }

  async function bind() {
    setBusy(true);
    setMessage("");
    try {
      const payload = await request("/api/bangumi/account", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accessToken: token }) });
      setAccount(payload.account as Binding);
      setToken("");
      setMessage("Bangumi 账号已绑定");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "绑定失败");
    } finally {
      setBusy(false);
    }
  }

  async function sync() {
    setBusy(true);
    setMessage("");
    try {
      const payload = await request("/api/bangumi/account/sync", { method: "POST" });
      await load();
      setMessage(`同步完成：新增或更新 ${String(payload.synced ?? 0)} 条${payload.failed ? `，失败 ${String(payload.failed)} 条` : ""}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "同步失败");
    } finally {
      setBusy(false);
    }
  }

  async function unbind() {
    if (!window.confirm("解绑后不会删除已有媒体，确认继续？")) return;
    setBusy(true);
    setMessage("");
    try {
      await request("/api/bangumi/account", { method: "DELETE" });
      setAccount(null);
      setMessage("Bangumi 账号已解绑，已有媒体记录保留");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "解绑失败");
    } finally {
      setBusy(false);
    }
  }

  return <main className="security-page">
    <header>
      <button className="auth-link" onClick={() => router.push("/")}>← 返回月下集</button>
      <h1>Bangumi 账号</h1>
      <button className="auth-link" onClick={() => router.push("/settings/security")}>账户安全</button>
    </header>
    <div className="security-grid bangumi-account-grid">
      <section className="security-card">
        <h2>绑定个人账号</h2>
        <p>Access Token 只会在 Worker 内使用 AES-GCM 加密保存，不会返回到页面或写入日志。</p>
        <label>Bangumi Access Token<input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="粘贴 Access Token" autoComplete="off" /></label>
        <button className="auth-primary" disabled={busy || !token.trim()} onClick={bind}>{busy ? "处理中…" : account ? "更新绑定" : "绑定账号"}</button>
      </section>
      <section className="security-card">
        <h2>绑定状态</h2>
        {account ? <>
          <p>用户 ID：{account.bangumiUserId}</p>
          <p>用户名：{account.username}</p>
          <p>最后同步：{formatDate(account.lastSyncAt)}</p>
          <button className="auth-primary" disabled={busy} onClick={sync}>{busy ? "同步中…" : "手动同步收藏"}</button>
          <button className="auth-link" disabled={busy} onClick={unbind}>解绑账号（不删除媒体）</button>
        </> : <p>当前尚未绑定 Bangumi 账号。</p>}
      </section>
    </div>
    {message && <p className="security-message" role="status">{message}</p>}
  </main>;
}

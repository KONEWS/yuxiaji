"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Security = {
  account: { username: string; twoFactorEnabled: boolean; mustChangePassword: boolean; sessionDuration: number };
  durations: number[];
  sessions: Array<{ id: number; deviceName: string; userAgent: string; ip: string; createdAt: string; lastUsedAt: string; expiresAt: string; current: boolean }>;
};

type BangumiBinding = {
  bangumiUserId: number;
  username: string;
  tokenExpiresAt: string | null;
  lastSyncAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type AnimeScheduleBinding = {
  configured: boolean;
  source: "settings" | "environment" | null;
  lastVerifiedAt: string | null;
  updatedAt: string | null;
};

type AniListStatus = {
  ok: boolean;
  status?: "正常" | "异常" | "未配置";
  latency?: number;
  checkedAt?: string;
};

const durationLabels: Record<number, string> = { 86400: "1 天", 604800: "7 天", 1296000: "15 天", 2592000: "30 天", 31536000: "1 年" };
const tokenValidityOptions = [7, 14, 30, 90, 180, 365];
const initialSecurity: Security = {
  account: { username: "", twoFactorEnabled: false, mustChangePassword: false, sessionDuration: 2592000 },
  durations: [86400, 604800, 1296000, 2592000, 31536000],
  sessions: [],
};

function expiryCountdown(expiresAt: string | null, now: number) {
  if (!expiresAt) return "未记录有效期";
  const remaining = new Date(expiresAt).getTime() - now;
  if (!Number.isFinite(remaining) || remaining <= 0) return "令牌已过期";
  const totalSeconds = Math.floor(remaining / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `剩余 ${days}天 ${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

async function apiRequest(path: string, init?: RequestInit) {
  const response = await fetch(path, init);
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const error = typeof payload.error === "string" ? payload.error : "请求失败";
    const details = typeof payload.details === "string" ? payload.details : "";
    throw new Error([error, details].filter(Boolean).join("："));
  }
  return payload;
}

export function SecurityPanel({ embedded = false, onClose }: { embedded?: boolean; onClose?: () => void }) {
  const router = useRouter();
  const [data, setData] = useState<Security>(initialSecurity);
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [passwords, setPasswords] = useState({ currentPassword: "", newPassword: "", totpCode: "" });
  const [username, setUsername] = useState("");
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [setupCode, setSetupCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [bangumi, setBangumi] = useState<BangumiBinding | null>(null);
  const [bangumiToken, setBangumiToken] = useState("");
  const [bangumiValidityDays, setBangumiValidityDays] = useState(7);
  const [bangumiSyncDirection, setBangumiSyncDirection] = useState<"pull" | "push">("pull");
  const [bangumiMessage, setBangumiMessage] = useState("");
  const [bangumiError, setBangumiError] = useState(false);
  const [animeSchedule, setAnimeSchedule] = useState<AnimeScheduleBinding | null>(null);
  const [animeScheduleToken, setAnimeScheduleToken] = useState("");
  const [animeScheduleMessage, setAnimeScheduleMessage] = useState("");
  const [animeScheduleError, setAnimeScheduleError] = useState(false);
  const [aniListStatus, setAniListStatus] = useState<AniListStatus | null>(null);
  const [sessionNameDrafts, setSessionNameDrafts] = useState<Record<number, string>>({});
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let active = true;
    apiRequest("/api/auth/security", { cache: "no-store" }).then(async (security) => {
      if (!active) return;
      const nextSecurity = security as unknown as Security;
      setData(nextSecurity);
      setUsername(nextSecurity.account.username);
      setSessionNameDrafts(Object.fromEntries(nextSecurity.sessions.map((session) => [session.id, session.deviceName || ""])));
      setReady(true);
      const [bangumiResult, animeScheduleResult, aniListResult] = await Promise.allSettled([
        apiRequest("/api/bangumi/account", { cache: "no-store" }),
        apiRequest("/api/integrations/animeschedule", { cache: "no-store" }),
        apiRequest("/api/health", { cache: "no-store" }),
      ]);
      if (!active) return;
      if (bangumiResult.status === "fulfilled") setBangumi((bangumiResult.value.account || null) as BangumiBinding | null);
      else { setBangumiError(true); setBangumiMessage(bangumiResult.reason instanceof Error ? bangumiResult.reason.message : "无法读取 Bangumi 绑定状态"); }
      if (animeScheduleResult.status === "fulfilled") setAnimeSchedule(animeScheduleResult.value as unknown as AnimeScheduleBinding);
      else { setAnimeScheduleError(true); setAnimeScheduleMessage(animeScheduleResult.reason instanceof Error ? animeScheduleResult.reason.message : "无法读取 AnimeSchedule 配置"); }
      if (aniListResult.status === "fulfilled") {
        const services = Array.isArray((aniListResult.value as { services?: unknown }).services) ? (aniListResult.value as { services: Array<AniListStatus & { id?: string }> }).services : [];
        const service = services.find((item) => item.id === "anilist");
        setAniListStatus(service ? { ok: Boolean(service.ok), status: service.status, latency: service.latency, checkedAt: String((aniListResult.value as { checkedAt?: unknown }).checkedAt || "") } : null);
      }
    }).catch(() => router.replace("/login"));
    return () => { active = false; };
  }, [router]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  async function refreshSecurity() {
    const refreshed = await apiRequest("/api/auth/security", { cache: "no-store" });
    const next = refreshed as unknown as Security;
    setData(next);
    setUsername(next.account.username);
    setSessionNameDrafts(Object.fromEntries(next.sessions.map((session) => [session.id, session.deviceName || ""])));
  }

  async function action(body: Record<string, unknown>) {
    setBusy(true);
    setMessage("");
    try {
      const payload = await apiRequest("/api/auth/security", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (Array.isArray(payload.backupCodes)) setBackupCodes(payload.backupCodes.map(String));
      setMessage("已保存");
      await refreshSecurity();
      return payload;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "操作失败");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function bindBangumi() {
    setBusy(true);
    setBangumiError(false);
    setBangumiMessage("正在验证 Access Token…");
    try {
      await apiRequest("/api/bangumi/account", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accessToken: bangumiToken, tokenValidityDays: bangumiValidityDays }),
      });
      const refreshed = await apiRequest("/api/bangumi/account", { cache: "no-store" });
      const account = (refreshed.account || null) as BangumiBinding | null;
      if (!account) throw new Error("Token 已验证，但未读取到保存后的账号状态");
      setBangumi(account);
      setBangumiToken("");
      setBangumiMessage(`绑定成功：${account.username}`);
    } catch (error) {
      setBangumiError(true);
      setBangumiMessage(error instanceof Error ? error.message : "绑定失败");
    } finally {
      setBusy(false);
    }
  }

  async function syncBangumiAccount() {
    if (bangumiSyncDirection === "push" && !window.confirm("将月下集中由 Bangumi 管理的条目状态、评分、标签和备注写入 Bangumi；动画进度只补记已看章节，不会取消远端记录。确认继续？")) return;
    setBusy(true);
    setBangumiError(false);
    setBangumiMessage(bangumiSyncDirection === "pull" ? "正在从 Bangumi 导入收藏…" : "正在同步月下集收藏到 Bangumi…");
    try {
      const payload = await apiRequest("/api/bangumi/account/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ direction: bangumiSyncDirection }),
      });
      const refreshed = await apiRequest("/api/bangumi/account", { cache: "no-store" });
      setBangumi((refreshed.account || null) as BangumiBinding | null);
      const firstError = Array.isArray(payload.errors) && payload.errors[0] && typeof payload.errors[0] === "object" ? String((payload.errors[0] as { error?: unknown }).error || "") : "";
      setBangumiMessage(`${bangumiSyncDirection === "pull" ? "导入" : "写入"}完成：成功 ${String(payload.synced ?? 0)} 条${payload.failed ? `，失败 ${String(payload.failed)} 条${firstError ? `（${firstError}）` : ""}` : ""}`);
    } catch (error) {
      setBangumiError(true);
      setBangumiMessage(error instanceof Error ? error.message : "同步失败");
    } finally {
      setBusy(false);
    }
  }

  async function unbindBangumi() {
    if (!window.confirm("解绑后不会删除已有媒体，确认继续？")) return;
    setBusy(true);
    setBangumiError(false);
    setBangumiMessage("正在解绑…");
    try {
      await apiRequest("/api/bangumi/account", { method: "DELETE" });
      setBangumi(null);
      setBangumiMessage("账号已解绑，已有媒体记录保留");
    } catch (error) {
      setBangumiError(true);
      setBangumiMessage(error instanceof Error ? error.message : "解绑失败");
    } finally {
      setBusy(false);
    }
  }

  async function bindAnimeSchedule() {
    setBusy(true);
    setAnimeScheduleError(false);
    setAnimeScheduleMessage("正在验证 Application Token…");
    try {
      const payload = await apiRequest("/api/integrations/animeschedule", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: animeScheduleToken }),
      });
      setAnimeSchedule(payload as unknown as AnimeScheduleBinding);
      setAnimeScheduleToken("");
      setAnimeScheduleMessage("AnimeSchedule 放送源已连接");
    } catch (error) {
      setAnimeScheduleError(true);
      setAnimeScheduleMessage(error instanceof Error ? error.message : "绑定失败");
    } finally {
      setBusy(false);
    }
  }

  async function unbindAnimeSchedule() {
    if (!window.confirm("确认移除 AnimeSchedule 设置页 Token 吗？")) return;
    setBusy(true);
    setAnimeScheduleError(false);
    try {
      const payload = await apiRequest("/api/integrations/animeschedule", { method: "DELETE" });
      setAnimeSchedule(payload as unknown as AnimeScheduleBinding);
      setAnimeScheduleMessage(payload.configured ? "已恢复使用 Worker 环境 Token" : "AnimeSchedule 已解绑");
    } catch (error) {
      setAnimeScheduleError(true);
      setAnimeScheduleMessage(error instanceof Error ? error.message : "解绑失败");
    } finally {
      setBusy(false);
    }
  }

  async function passwordSubmit(event: FormEvent) {
    event.preventDefault();
    await action({ action: "password", ...passwords, revokeOtherSessions: false });
    setPasswords({ currentPassword: "", newPassword: "", totpCode: "" });
  }

  const leave = () => embedded ? onClose?.() : router.push("/");
  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
  };

  return <section className={`security-panel ${embedded ? "embedded" : "standalone"}`} aria-busy={!ready}>
    <header className="security-panel-header">
      <button className="security-back" onClick={leave}>{embedded ? "← 返回设置" : "← 返回月下集"}</button>
      <div><p>{embedded ? "管理员设置" : "月下集"}</p><h1>账户安全</h1></div>
      {embedded ? <button className="security-close" onClick={onClose} aria-label="关闭账户安全">×</button> : <button className="security-back" onClick={logout}>注销</button>}
    </header>
    <div className={`security-panel-progress ${ready ? "ready" : ""}`} aria-hidden="true" />
    <div className="security-grid">
      <div className="security-column">
      <section className="security-card account-security-card">
        <div className="security-card-title"><div><h2>账户</h2><p>用户名与登录密码</p></div><span>管理员</span></div>
        <label>用户名<input value={username} disabled={!ready || busy} onChange={(event) => setUsername(event.target.value)} /></label>
        <button className="auth-primary" disabled={!ready || busy} onClick={() => action({ action: "username", username, currentPassword: window.prompt("请输入当前密码") || "", totpCode: window.prompt("如已开启 2FA，请输入验证码") || "" })}>保存用户名</button>
        <form onSubmit={passwordSubmit}>
          <h3>修改密码</h3>
          <label>当前密码<input type="password" value={passwords.currentPassword} disabled={!ready || busy} onChange={(event) => setPasswords({ ...passwords, currentPassword: event.target.value })} required /></label>
          <label>新密码（至少 12 位）<input type="password" value={passwords.newPassword} disabled={!ready || busy} onChange={(event) => setPasswords({ ...passwords, newPassword: event.target.value })} required /></label>
          {data.account.twoFactorEnabled && <label>TOTP 验证码<input value={passwords.totpCode} disabled={!ready || busy} onChange={(event) => setPasswords({ ...passwords, totpCode: event.target.value })} inputMode="numeric" required /></label>}
          <button className="auth-primary" disabled={!ready || busy}>修改密码</button>
        </form>
      </section>

      <section className="security-card integration-card bangumi-card">
        <div className="security-card-title"><div><h2>Bangumi 账号</h2><p>收藏与进度双向同步</p></div><span className={bangumi ? "enabled" : ""}>{bangumi ? "已绑定" : "未绑定"}</span></div>
        <p>Access Token 仅在 Worker 内加密保存。<a href="https://next.bgm.tv/demo/access-token" target="_blank" rel="noreferrer">创建令牌 ↗</a></p>
        <div className="security-form-row"><label>Access Token<input type="password" value={bangumiToken} onChange={(event) => setBangumiToken(event.target.value)} placeholder="粘贴 Bangumi Access Token" autoComplete="off" /></label><label>令牌有效期<select value={bangumiValidityDays} onChange={(event) => setBangumiValidityDays(Number(event.target.value))}>{tokenValidityOptions.map((days) => <option key={days} value={days}>{days} 天</option>)}</select></label></div>
        <small className="security-hint">有效期需与 Bangumi 创建令牌时的选项一致</small>
        <button className="auth-primary" disabled={busy || !bangumiToken.trim()} onClick={bindBangumi}>{busy ? "处理中…" : bangumi ? "更新绑定" : "绑定账号"}</button>
        {bangumiMessage && <p className={`bangumi-binding-message ${bangumiError ? "error" : "success"}`} role="status" aria-live="polite">{bangumiMessage}</p>}
        {bangumi ? <div className="bangumi-binding-status"><b>{bangumi.username}</b><span>用户 ID：{bangumi.bangumiUserId}</span><strong className={bangumi.tokenExpiresAt && new Date(bangumi.tokenExpiresAt).getTime() <= now ? "expired" : ""}>{expiryCountdown(bangumi.tokenExpiresAt, now)}</strong><span>最后同步：{bangumi.lastSyncAt ? new Date(bangumi.lastSyncAt).toLocaleString("zh-CN") : "尚未同步"}</span><div className="bangumi-sync-direction" role="group" aria-label="Bangumi 同步方向"><button className={bangumiSyncDirection === "pull" ? "active" : ""} onClick={() => setBangumiSyncDirection("pull")}>↓ 从 Bangumi 导入</button><button className={bangumiSyncDirection === "push" ? "active" : ""} onClick={() => setBangumiSyncDirection("push")}>↑ 同步到 Bangumi</button></div><button className="auth-primary" disabled={busy} onClick={syncBangumiAccount}>{busy ? "同步中…" : bangumiSyncDirection === "pull" ? "开始导入收藏" : "开始写入 Bangumi"}</button><button className="auth-link" disabled={busy} onClick={unbindBangumi}>解绑账号（不删除媒体）</button></div> : null}
      </section>
      <section className="security-card integration-card anilist-card">
        <div className="security-card-title"><div><h2>AniList</h2><p>放送时间与封面补充</p></div><span className={aniListStatus?.ok ? "enabled" : ""}>{aniListStatus ? (aniListStatus.ok ? "已启用" : aniListStatus.status || "异常") : "检查中"}</span></div>
        <p>使用 AniList 公共 GraphQL API，不需要单独配置令牌。用于补充下一集时间、集数和封面，不会修改你的收藏。</p>
        <div className="bangumi-binding-status anilist-status"><span>接口状态：{aniListStatus ? (aniListStatus.ok ? "正常" : aniListStatus.status || "异常") : "检测中"}</span><span>最近检查：{aniListStatus?.checkedAt ? new Date(aniListStatus.checkedAt).toLocaleString("zh-CN") : "—"}</span>{typeof aniListStatus?.latency === "number" && <span>响应：{aniListStatus.latency} ms</span>}</div>
        <div className="anilist-card-actions"><a className="auth-link" href="https://docs.anilist.co/" target="_blank" rel="noreferrer">查看 API 文档 ↗</a></div>
      </section>
      </div>

      <div className="security-column">
      <section className="security-card compact-security-card">
        <div className="security-card-title"><div><h2>二次验证</h2><p>验证器与恢复码</p></div><span className={data.account.twoFactorEnabled ? "enabled" : ""}>{data.account.twoFactorEnabled ? "已开启" : "未开启"}</span></div>
        {!data.account.twoFactorEnabled ? <>{!setup ? <button className="auth-primary" disabled={!ready || busy} onClick={async () => { const payload = await action({ action: "2fa-start" }); if (payload) setSetup({ secret: String(payload.secret), otpauthUri: String(payload.otpauthUri) }); }}>开启 2FA</button> : <div className="totp-setup"><p>在验证器中添加以下密钥：</p><code>{setup.secret}</code><input placeholder="输入 6 位验证码" value={setupCode} onChange={(event) => setSetupCode(event.target.value)} /><button className="auth-primary" onClick={() => action({ action: "2fa-enable", secret: setup.secret, totpCode: setupCode, currentPassword: window.prompt("请输入当前密码") || "" })}>确认开启</button></div>}</> : <div className="security-inline-actions"><button className="auth-link" onClick={() => action({ action: "2fa-disable", currentPassword: window.prompt("请输入当前密码") || "", totpCode: window.prompt("请输入当前 TOTP") || "" })}>关闭 2FA</button><button className="auth-link" onClick={() => action({ action: "recovery-regenerate", currentPassword: window.prompt("请输入当前密码") || "", totpCode: window.prompt("请输入当前 TOTP") || "" })}>重新生成恢复码</button></div>}
        {backupCodes.length > 0 && <div className="backup-codes"><b>恢复码（只显示这一次）</b><code>{backupCodes.join("\n")}</code></div>}
      </section>

      <section className="security-card integration-card anime-schedule-card">
        <div className="security-card-title"><div><h2>AnimeSchedule</h2><p>精确放送时间来源</p></div><span className={animeSchedule?.configured ? "enabled" : ""}>{animeSchedule?.configured ? "已连接" : "未配置"}</span></div>
        <p>使用官方 v3 API 补充放送时间。<a href="https://animeschedule.net/users/KONEHENTAI/settings/api" target="_blank" rel="noreferrer">获取 Application Token ↗</a></p>
        <label>Application Token<input type="password" value={animeScheduleToken} onChange={(event) => setAnimeScheduleToken(event.target.value)} placeholder="粘贴 AnimeSchedule Application Token" autoComplete="off" /></label>
        <button className="auth-primary" disabled={busy || !animeScheduleToken.trim()} onClick={bindAnimeSchedule}>{busy ? "处理中…" : animeSchedule?.configured ? "更新连接" : "连接放送源"}</button>
        {animeScheduleMessage && <p className={`bangumi-binding-message ${animeScheduleError ? "error" : "success"}`} role="status" aria-live="polite">{animeScheduleMessage}</p>}
        {animeSchedule?.configured && <div className="bangumi-binding-status"><span>凭据来源：{animeSchedule.source === "settings" ? "账户安全设置" : "Worker 环境变量"}</span><span>最近验证：{animeSchedule.lastVerifiedAt ? new Date(animeSchedule.lastVerifiedAt).toLocaleString("zh-CN") : "环境变量模式"}</span>{animeSchedule.source === "settings" && <button className="auth-link" disabled={busy} onClick={unbindAnimeSchedule}>移除设置页 Token</button>}</div>}
      </section>
      </div>

      <section className="security-card security-sessions-card">
        <div className="security-card-title"><div><h2>登录设备</h2><p>会话期限与设备管理</p></div><span>{data.sessions.length} 台</span></div>
        <div className="session-duration-row"><label>登录保持时间<select value={data.account.sessionDuration} disabled={!ready || busy} onChange={(event) => action({ action: "duration", sessionDuration: Number(event.target.value) })}>{data.durations.map((duration) => <option key={duration} value={duration}>{durationLabels[duration] || `${duration} 秒`}</option>)}</select></label><button className="auth-link danger-link" disabled={!ready || busy} onClick={() => action({ action: "session-delete-all" })}>注销所有设备</button></div>
        <div className="session-list">{data.sessions.map((session) => { const draft = sessionNameDrafts[session.id] ?? session.deviceName ?? ""; return <div className="session-row" key={session.id}><b>{draft || (session.current ? "当前设备" : "登录设备")}</b><span>{session.userAgent || "未知浏览器"}</span><small>{session.ip || "未知 IP"} · 到期 {new Date(session.expiresAt).toLocaleString("zh-CN")}</small><div className="session-row-actions"><input className="session-device-name" value={draft} maxLength={60} placeholder="自定义设备名称" aria-label={`${session.current ? "当前" : "登录"}设备名称`} onChange={(event) => setSessionNameDrafts((names) => ({ ...names, [session.id]: event.target.value }))} /><button className="auth-link" disabled={!draft.trim() || busy} onClick={() => action({ action: "session-rename", id: session.id, deviceName: draft })}>保存</button><button className="auth-link" disabled={busy} onClick={() => action({ action: "session-delete", id: session.id })}>注销</button></div></div>; })}</div>
      </section>
    </div>
    {message && <p className="security-message" role="status">{message}</p>}
  </section>;
}

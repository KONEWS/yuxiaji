"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

type Status = { initialized: boolean; authenticated: boolean; account?: { username: string; mustChangePassword: boolean } | null };

function safeNext(value: string | null) {
  return value?.startsWith("/") && !value.startsWith("//") ? value : "/";
}

export default function LoginPage() {
  const router = useRouter();
  const search = useSearchParams();
  const [status, setStatus] = useState<Status | null>(null);
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<"login" | "2fa">("login");
  const [message, setMessage] = useState("");
  const [temporaryPassword, setTemporaryPassword] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    fetch("/api/auth/status", { cache: "no-store" })
      .then((response) => response.json() as Promise<Status>)
      .then((nextStatus) => {
        if (!active) return;
        if (nextStatus.authenticated) {
          const destination = safeNext(search.get("next"));
          router.replace(nextStatus.account?.mustChangePassword ? "/settings/security?force=1" : destination);
          return;
        }
        setStatus(nextStatus);
      })
      .catch(() => { if (active) setMessage("认证服务暂时不可用"); });
    return () => { active = false; };
  }, [router, search]);

  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      const endpoint = stage === "2fa" ? "/api/auth/2fa" : "/api/auth/login";
      const body = stage === "2fa" ? { code } : { username, password };
      const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "登录失败");
      if (payload.requires2fa) { setStage("2fa"); setCode(""); return; }
      router.replace(payload.account?.mustChangePassword ? "/settings/security?force=1" : safeNext(search.get("next")));
    } catch (error) { setMessage(error instanceof Error ? error.message : "登录失败"); }
    finally { setBusy(false); }
  }

  async function initialize() {
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/auth/init", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "初始化失败");
      setTemporaryPassword(payload.temporaryPassword); setStatus({ initialized: true, authenticated: false }); setMessage("管理员创建成功。临时密码只会显示这一次。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "初始化失败"); }
    finally { setBusy(false); }
  }

  if (!status) return <main className="auth-page"><section className="auth-card"><p>月下集</p><h1>正在检查管理员状态</h1></section></main>;
  return <main className="auth-page"><section className="auth-card">
    <p className="auth-kicker">月下集 · 私人收藏</p><h1>{stage === "2fa" ? "输入验证码" : "管理员登录"}</h1>
    {stage === "2fa" ? <p className="auth-help">打开验证器，输入当前 6 位 TOTP；也可以输入一个恢复码。</p> : <p className="auth-help">此站点只允许一个管理员账号，浏览器数据不会保存登录令牌。</p>}
    {!status.initialized && stage === "login" ? <div className="auth-init"><p>尚未初始化管理员。创建后请保存一次性临时密码。</p><label>管理员用户名<input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" /></label><button className="auth-primary" onClick={initialize} disabled={busy}>创建管理员</button></div> : <form onSubmit={submit}>
      {stage === "login" && <><label>用户名<input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required /></label><label>密码<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /></label></>}
      {stage === "2fa" && <label>6 位验证码或恢复码<input inputMode="numeric" value={code} onChange={(event) => setCode(event.target.value)} autoFocus required /></label>}
      <button className="auth-primary" disabled={busy}>{busy ? "验证中…" : stage === "2fa" ? "验证并登录" : "登录"}</button>
      {stage === "2fa" && <button type="button" className="auth-link" onClick={() => { setStage("login"); setCode(""); }}>返回密码登录</button>}
    </form>}
    {temporaryPassword && <div className="temporary-password"><b>一次性临时密码</b><code>{temporaryPassword}</code><small>请立即复制到密码管理器。关闭此页面后不会再次显示。</small></div>}
    {message && <p className="auth-message" role="status">{message}</p>}
  </section></main>;
}

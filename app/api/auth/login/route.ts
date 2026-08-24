import { createSession, csrfFailure, loadAdminAccount, loginFailureCount, publicAccount, verifyPassword, writeAuthLog, CHALLENGE_COOKIE } from "../../../lib/admin-auth";

export async function POST(request: Request) {
  const csrf = csrfFailure(request);
  if (csrf) return csrf;
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; } catch { return Response.json({ error: "请求体必须是 JSON" }, { status: 400 }); }
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  try {
    const account = await loadAdminAccount();
    if (!account) return Response.json({ error: "管理员尚未初始化", code: "NOT_INITIALIZED" }, { status: 428 });
    if (await loginFailureCount(request, username) >= 10) return Response.json({ error: "登录失败次数过多，请 15 分钟后重试" }, { status: 429 });
    const valid = username === account.username && await verifyPassword(password, account.passwordHash);
    if (!valid) {
      await writeAuthLog(request, "login_failed", { username });
      return Response.json({ error: "用户名或密码错误" }, { status: 401 });
    }
    if (account.twoFactorEnabled) {
      const pending = await createSession(request, account.id, 300, true);
      const headers = new Headers({ "cache-control": "no-store" });
      headers.append("set-cookie", `${CHALLENGE_COOKIE}=${pending.token}; Max-Age=300; Path=/; HttpOnly; Secure; SameSite=Lax`);
      return Response.json({ ok: true, requires2fa: true }, { headers });
    }
    const session = await createSession(request, account.id, account.sessionDuration);
    await writeAuthLog(request, "login_success", { username: account.username, sessionId: session.session.id });
    return Response.json({ ok: true, account: publicAccount(account) }, { headers: new Headers({ "set-cookie": session.cookie, "cache-control": "no-store" }) });
  } catch (error) {
    return Response.json({ error: "登录失败", details: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

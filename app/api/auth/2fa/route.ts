import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { adminSessions } from "../../../../db/schema";
import { CHALLENGE_COOKIE, consumeBackupCode, createSession, csrfFailure, getPendingChallenge, loadAdminAccount, reserveTwoFactorAttempt, verifyTotp, writeAuthLog } from "../../../lib/admin-auth";

const MAX_ATTEMPTS = 5;

function exhaustedChallenge() {
  return Response.json({ error: "验证码错误次数过多，请重新登录", code: "TWO_FACTOR_ATTEMPTS_EXHAUSTED" }, {
    status: 429,
    headers: { "cache-control": "no-store", "set-cookie": `${CHALLENGE_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax` },
  });
}

export async function POST(request: Request) {
  const csrf = csrfFailure(request);
  if (csrf) return csrf;
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; } catch { return Response.json({ error: "请求体必须是 JSON" }, { status: 400 }); }
  try {
    const account = await loadAdminAccount();
    const pending = await getPendingChallenge(request);
    if (!account || !pending) return Response.json({ error: "2FA 验证已过期，请重新登录" }, { status: 401 });
    const attempt = await reserveTwoFactorAttempt(pending.id, MAX_ATTEMPTS);
    if (!attempt.allowed) return exhaustedChallenge();
    const code = typeof body.code === "string" ? body.code : typeof body.recoveryCode === "string" ? body.recoveryCode : "";
    const validTotp = await verifyTotp(account.totpSecret, code);
    const validRecovery = !validTotp && code.trim() ? await consumeBackupCode(account, code) : false;
    if (!validTotp && !validRecovery) {
      await writeAuthLog(request, "two_factor_failed", { username: account.username, sessionId: pending.id });
      if (attempt.attempts >= MAX_ATTEMPTS) {
        await getDb().delete(adminSessions).where(eq(adminSessions.id, pending.id));
        return exhaustedChallenge();
      }
      return Response.json({ error: "验证码错误", remainingAttempts: MAX_ATTEMPTS - attempt.attempts }, { status: 401, headers: { "cache-control": "no-store" } });
    }
    await getDb().delete(adminSessions).where(eq(adminSessions.id, pending.id));
    const session = await createSession(request, account.id, account.sessionDuration);
    await writeAuthLog(request, "login_success", { username: account.username, sessionId: session.session.id, metadata: { recoveryCode: validRecovery } });
    const headers = new Headers({ "set-cookie": session.cookie, "cache-control": "no-store" });
    headers.append("set-cookie", `${CHALLENGE_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`);
    return Response.json({ ok: true }, { headers });
  } catch (error) {
    return Response.json({ error: "2FA 验证失败", details: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

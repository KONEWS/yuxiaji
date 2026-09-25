import { eq, ne } from "drizzle-orm";
import { getDb } from "../../../../db";
import { adminAccount, adminSessions } from "../../../../db/schema";
import { createBackupCodes, csrfFailure, generateTotpSecret, getAdminSession, hashPassword, listSessions, publicAccount, requireAdminSession, sessionDurations, totpUri, verifyPassword, verifyTotp, writeAuthLog, type AdminAccount } from "../../../lib/admin-auth";

const allowedDurations = new Set<number>(sessionDurations());

function requestFieldNames(body: Record<string, unknown>) {
  return Object.keys(body).sort();
}

async function logSecurityWrite(request: Request, current: Awaited<ReturnType<typeof getAdminSession>> & object, event: string, metadata: Record<string, unknown>) {
  await writeAuthLog(request, event, {
    username: current.account.username,
    sessionId: current.session.id,
    metadata,
  });
}

async function sensitiveCheck(_request: Request, account: AdminAccount, body: Record<string, unknown>) {
  const password = typeof body.currentPassword === "string" ? body.currentPassword : "";
  if (!await verifyPassword(password, account.passwordHash)) return Response.json({ error: "当前密码错误" }, { status: 401 });
  if (account.twoFactorEnabled) {
    const code = typeof body.totpCode === "string" ? body.totpCode : "";
    if (!await verifyTotp(account.totpSecret, code)) return Response.json({ error: "TOTP 验证码错误" }, { status: 401 });
  }
  return null;
}

export async function GET(request: Request) {
  const current = await requireAdminSession(request);
  if (current instanceof Response) return current;
  const sessions = await listSessions();
  return Response.json({ account: publicAccount(current.account), durations: sessionDurations(), sessions: sessions.map((session) => ({ id: session.id, deviceName: session.deviceName || "", userAgent: session.userAgent, ip: session.ip, createdAt: session.createdAt, lastUsedAt: session.lastUsedAt, expiresAt: session.expiresAt, current: session.id === current.session.id })) }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  const csrf = csrfFailure(request);
  if (csrf) return csrf;
  const current = await requireAdminSession(request);
  if (current instanceof Response) return current;
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; } catch { return Response.json({ error: "请求体必须是 JSON" }, { status: 400 }); }
  const action = typeof body.action === "string" && body.action
    ? body.action
    : typeof body.username === "string" ? "username"
    : typeof body.newPassword === "string" ? "password"
    : "";
  const patchEvent = request.method === "PATCH" ? "security_patch_received" : "security_update_received";
  await logSecurityWrite(request, current, patchEvent, {
    fields: requestFieldNames(body),
    branch: action || "unknown",
  });
  try {
    if (action === "duration") {
      const duration = Number(body.sessionDuration);
      if (!allowedDurations.has(duration)) return Response.json({ error: "不支持的 Session 时长" }, { status: 400 });
      await getDb().update(adminAccount).set({ sessionDuration: duration, updatedAt: new Date() }).where(eq(adminAccount.id, current.account.id));
      return Response.json({ ok: true, sessionDuration: duration });
    }
    if (action === "session-delete") {
      const id = Number(body.id);
      if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "缺少 Session id" }, { status: 400 });
      await getDb().delete(adminSessions).where(eq(adminSessions.id, id));
      await writeAuthLog(request, "session_revoked", { username: current.account.username, sessionId: id });
      const headers = id === current.session.id ? { "set-cookie": (await import("../../../lib/admin-auth")).clearSessionCookie() } : undefined;
      return Response.json({ ok: true }, { headers });
    }
    if (action === "session-rename") {
      const id = Number(body.id);
      const deviceName = typeof body.deviceName === "string" ? body.deviceName.trim().slice(0, 60) : "";
      if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "缺少 Session id" }, { status: 400 });
      if (!deviceName) return Response.json({ error: "设备名称不能为空" }, { status: 400 });
      const updatedRows = await getDb().update(adminSessions).set({ deviceName }).where(eq(adminSessions.id, id)).returning({ id: adminSessions.id, deviceName: adminSessions.deviceName });
      await logSecurityWrite(request, current, "security_update_result", { branch: "session-rename", updateRows: updatedRows.length });
      if (!updatedRows.length) return Response.json({ error: "Session 不存在" }, { status: 404 });
      await writeAuthLog(request, "session_renamed", { username: current.account.username, sessionId: id, metadata: { deviceName } });
      return Response.json({ ok: true, ...updatedRows[0] });
    }
    if (action === "session-delete-all") {
      await getDb().delete(adminSessions);
      await writeAuthLog(request, "session_revoked_all", { username: current.account.username });
      return Response.json({ ok: true }, { headers: { "set-cookie": (await import("../../../lib/admin-auth")).clearSessionCookie() } });
    }
    if (action === "2fa-start") {
      const secret = generateTotpSecret();
      return Response.json({ ok: true, secret, otpauthUri: totpUri(secret, current.account.username) }, { headers: { "cache-control": "no-store" } });
    }
    if (action === "2fa-enable") {
      const check = await sensitiveCheck(request, current.account, { ...body, currentPassword: body.currentPassword || "" });
      if (check) return check;
      const secret = typeof body.secret === "string" ? body.secret.trim().toUpperCase() : "";
      const code = typeof body.totpCode === "string" ? body.totpCode : "";
      if (!secret || !await verifyTotp(secret, code)) return Response.json({ error: "请先输入有效的 TOTP 验证码" }, { status: 400 });
      const backup = await createBackupCodes(10);
      await getDb().update(adminAccount).set({ totpSecret: secret, twoFactorEnabled: true, backupCodes: JSON.stringify(backup.hashes), updatedAt: new Date() }).where(eq(adminAccount.id, current.account.id));
      await writeAuthLog(request, "two_factor_enabled", { username: current.account.username });
      return Response.json({ ok: true, backupCodes: backup.plain });
    }
    if (action === "2fa-disable") {
      const check = await sensitiveCheck(request, current.account, body);
      if (check) return check;
      await getDb().update(adminAccount).set({ totpSecret: "", twoFactorEnabled: false, backupCodes: "[]", updatedAt: new Date() }).where(eq(adminAccount.id, current.account.id));
      await writeAuthLog(request, "two_factor_disabled", { username: current.account.username });
      return Response.json({ ok: true });
    }
    if (action === "recovery-regenerate") {
      const check = await sensitiveCheck(request, current.account, body);
      if (check) return check;
      const backup = await createBackupCodes(10);
      await getDb().update(adminAccount).set({ backupCodes: JSON.stringify(backup.hashes), updatedAt: new Date() }).where(eq(adminAccount.id, current.account.id));
      await writeAuthLog(request, "recovery_codes_regenerated", { username: current.account.username });
      return Response.json({ ok: true, backupCodes: backup.plain });
    }
    if (action === "password") {
      const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
      const nextPassword = typeof body.newPassword === "string" ? body.newPassword : "";
      if (!await verifyPassword(currentPassword, current.account.passwordHash)) return Response.json({ error: "当前密码错误" }, { status: 401 });
      if (current.account.twoFactorEnabled && !await verifyTotp(current.account.totpSecret, typeof body.totpCode === "string" ? body.totpCode : "")) return Response.json({ error: "TOTP 验证码错误" }, { status: 401 });
      if (nextPassword.length < 12 || nextPassword.length > 256) return Response.json({ error: "新密码长度需为 12-256 位" }, { status: 400 });
      const updatedRows = await getDb().update(adminAccount).set({
        passwordHash: await hashPassword(nextPassword),
        // This is the durable one-time setup completion marker used by the
        // Worker guard. It is intentionally cleared only after a valid change.
        mustChangePassword: false,
        updatedAt: new Date(),
      }).where(eq(adminAccount.id, current.account.id)).returning({ id: adminAccount.id, mustChangePassword: adminAccount.mustChangePassword });
      const updated = updatedRows[0];
      const [freshAccount] = await getDb().select({ mustChangePassword: adminAccount.mustChangePassword }).from(adminAccount).where(eq(adminAccount.id, current.account.id)).limit(1);
      const setupCompleted = Boolean(freshAccount) && freshAccount.mustChangePassword !== true && Number(freshAccount.mustChangePassword) !== 1;
      await logSecurityWrite(request, current, "security_update_result", { branch: "password", updateRows: updatedRows.length, mustChangePassword: setupCompleted ? false : freshAccount?.mustChangePassword ?? null });
      if (!updated || !setupCompleted) throw new Error("首次密码设置状态未能保存");
      if (body.revokeOtherSessions) await getDb().delete(adminSessions).where(ne(adminSessions.id, current.session.id));
      await writeAuthLog(request, "password_changed", { username: current.account.username, sessionId: current.session.id });
      return Response.json({ ok: true, setupCompleted: true, mustChangePassword: false, updateRows: updatedRows.length });
    }
    if (action === "username") {
      const check = await sensitiveCheck(request, current.account, body);
      if (check) return check;
      const username = typeof body.username === "string" ? body.username.trim() : "";
      if (!/^[\p{L}\p{N}_.-]{2,40}$/u.test(username)) return Response.json({ error: "用户名需为 2-40 个字母、数字或常用符号" }, { status: 400 });
      const updatedRows = await getDb().update(adminAccount).set({ username, updatedAt: new Date() }).where(eq(adminAccount.id, current.account.id)).returning({ id: adminAccount.id, username: adminAccount.username });
      await logSecurityWrite(request, current, "security_update_result", { branch: "username", updateRows: updatedRows.length });
      if (!updatedRows.length) throw new Error("用户名更新未影响管理员记录");
      await writeAuthLog(request, "username_changed", { username, sessionId: current.session.id });
      return Response.json({ ok: true, username: updatedRows[0]?.username || username, updateRows: updatedRows.length });
    }
    return Response.json({ error: "未知安全操作" }, { status: 400 });
  } catch (error) {
    return Response.json({ error: "安全设置操作失败", details: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

// Keep the security API compatible with clients that use resource-style
// PATCH for account updates. Both methods share the same guarded write path.
export function PATCH(request: Request) {
  return POST(request);
}

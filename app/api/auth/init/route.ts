import { getDb } from "../../../../db";
import { adminAccount } from "../../../../db/schema";
import { csrfFailure, hashPassword, loadAdminAccount, writeAuthLog } from "../../../lib/admin-auth";

function randomTemporaryPassword() {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((byte) => (byte % 36).toString(36)).join("").slice(0, 18);
}

export async function POST(request: Request) {
  const csrf = csrfFailure(request);
  if (csrf) return csrf;
  try {
    if (await loadAdminAccount()) return Response.json({ error: "管理员已经初始化" }, { status: 409 });
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const username = typeof body.username === "string" ? body.username.trim() : "admin";
    if (!/^[\p{L}\p{N}_.-]{2,40}$/u.test(username)) return Response.json({ error: "用户名需为 2-40 个字母、数字或常用符号" }, { status: 400 });
    const temporaryPassword = randomTemporaryPassword();
    const now = new Date();
    // Pin the only account to id=1 so two concurrent first-run requests cannot
    // create multiple administrators with different usernames.
    const [created] = await getDb().insert(adminAccount).values({ id: 1, username, passwordHash: await hashPassword(temporaryPassword), sessionDuration: 2592000, mustChangePassword: true, createdAt: now, updatedAt: now }).returning({ id: adminAccount.id });
    if (!created) return Response.json({ error: "管理员创建失败" }, { status: 500 });
    await writeAuthLog(request, "admin_initialized", { username });
    return Response.json({ ok: true, username, temporaryPassword, warning: "临时密码只显示这一次，请立即登录并修改密码" }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (String(error).toLowerCase().includes("unique")) return Response.json({ error: "管理员已经初始化" }, { status: 409 });
    return Response.json({ error: "初始化失败", details: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

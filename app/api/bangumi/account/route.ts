import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { bangumiAccount } from "../../../../db/schema";
import { encryptBangumiToken } from "../../../lib/bangumi-account";
import { getBangumiCurrentUser } from "../../../lib/bangumi-api";
import { csrfFailure, requireAdminSession } from "../../../lib/admin-auth";

function publicBinding(row: typeof bangumiAccount.$inferSelect | null) {
  if (!row) return null;
  return {
    bangumiUserId: row.bangumiUserId,
    username: row.username,
    tokenExpiresAt: row.tokenExpiresAt ? new Date(row.tokenExpiresAt).toISOString() : null,
    lastSyncAt: row.lastSyncAt ? new Date(row.lastSyncAt).toISOString() : null,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

export async function GET(request: Request) {
  const current = await requireAdminSession(request);
  if (current instanceof Response) return current;
  const [row] = await getDb().select().from(bangumiAccount).where(eq(bangumiAccount.adminId, current.account.id)).limit(1);
  return Response.json({ account: publicBinding(row || null) }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  const csrf = csrfFailure(request);
  if (csrf) return csrf;
  const current = await requireAdminSession(request);
  if (current instanceof Response) return current;
  try {
    const body = await request.json() as Record<string, unknown>;
    const token = typeof body.accessToken === "string" ? body.accessToken.trim() : typeof body.token === "string" ? body.token.trim() : "";
    const validityDays = Number(body.tokenValidityDays);
    const allowedValidityDays = new Set([7, 14, 30, 90, 180, 365]);
    if (!token || token.length > 512) return Response.json({ error: "请填写有效的 Bangumi Access Token" }, { status: 400 });
    if (!allowedValidityDays.has(validityDays)) return Response.json({ error: "请选择与 Bangumi 令牌一致的有效期" }, { status: 400 });
    const user = await getBangumiCurrentUser({ userToken: token });
    const username = (user.username || user.nickname || "").trim();
    if (!Number.isInteger(user.id) || user.id <= 0 || !username) return Response.json({ error: "Bangumi 用户资料不完整" }, { status: 502 });
    const now = new Date();
    const tokenExpiresAt = new Date(now.getTime() + validityDays * 24 * 60 * 60 * 1000);
    const tokenCiphertext = await encryptBangumiToken(token);
    const db = getDb();
    const existing = await db.select({ adminId: bangumiAccount.adminId }).from(bangumiAccount).where(eq(bangumiAccount.adminId, current.account.id)).limit(1);
    if (existing.length) {
      await db.update(bangumiAccount).set({ bangumiUserId: user.id, username, tokenCiphertext, tokenExpiresAt, updatedAt: now }).where(eq(bangumiAccount.adminId, current.account.id));
    } else {
      await db.insert(bangumiAccount).values({ adminId: current.account.id, bangumiUserId: user.id, username, tokenCiphertext, tokenExpiresAt, lastSyncAt: null, createdAt: now, updatedAt: now });
    }
    const [saved] = await db.select().from(bangumiAccount).where(eq(bangumiAccount.adminId, current.account.id)).limit(1);
    return Response.json({ ok: true, account: publicBinding(saved || null) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ error: "Bangumi 账号绑定失败", details: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}

export async function DELETE(request: Request) {
  const csrf = csrfFailure(request);
  if (csrf) return csrf;
  const current = await requireAdminSession(request);
  if (current instanceof Response) return current;
  try {
    await getDb().delete(bangumiAccount).where(eq(bangumiAccount.adminId, current.account.id));
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: "Bangumi 账号解绑失败", details: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

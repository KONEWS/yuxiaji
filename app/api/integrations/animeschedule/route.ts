import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { externalServiceCredentials } from "../../../../db/schema";
import { csrfFailure, requireAdminSession } from "../../../lib/admin-auth";
import { encryptCredential } from "../../../lib/bangumi-account";
import { ANIMESCHEDULE_PROVIDER, getAnimeScheduleCredential, hasEnvironmentAnimeScheduleToken } from "../../../lib/integration-credentials";

function publicStatus(input: Awaited<ReturnType<typeof getAnimeScheduleCredential>>) {
  return {
    configured: Boolean(input.token),
    source: input.source,
    lastVerifiedAt: input.row?.lastVerifiedAt ? new Date(input.row.lastVerifiedAt).toISOString() : null,
    updatedAt: input.row?.updatedAt ? new Date(input.row.updatedAt).toISOString() : null,
  };
}

async function verifyToken(token: string) {
  const response = await fetch("https://animeschedule.net/api/v3/timetables/raw?tz=Asia%2FTokyo", {
    headers: { accept: "application/json", authorization: `Bearer ${token}`, "user-agent": "jlHKO/yuexiaji/0.1.0" },
    signal: AbortSignal.timeout(8000),
  });
  if (response.status === 401 || response.status === 403) throw new Error("AnimeSchedule Token 无效或没有 timetable 读取权限");
  if (!response.ok) throw new Error(`AnimeSchedule 返回 HTTP ${response.status}`);
  await response.json();
}

export async function GET(request: Request) {
  const current = await requireAdminSession(request);
  if (current instanceof Response) return current;
  try {
    return Response.json(publicStatus(await getAnimeScheduleCredential()), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ error: "读取 AnimeSchedule 配置失败", details: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const csrf = csrfFailure(request);
  if (csrf) return csrf;
  const current = await requireAdminSession(request);
  if (current instanceof Response) return current;
  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const token = typeof body.token === "string" ? body.token.trim().replace(/^Bearer\s+/i, "") : "";
    if (!token || token.length > 1024) return Response.json({ error: "请填写有效的 AnimeSchedule Application Token" }, { status: 400 });
    await verifyToken(token);
    const now = new Date();
    const tokenCiphertext = await encryptCredential(token);
    const [existing] = await getDb().select({ provider: externalServiceCredentials.provider }).from(externalServiceCredentials).where(eq(externalServiceCredentials.provider, ANIMESCHEDULE_PROVIDER)).limit(1);
    if (existing) {
      await getDb().update(externalServiceCredentials).set({ adminId: current.account.id, tokenCiphertext, lastVerifiedAt: now, updatedAt: now }).where(eq(externalServiceCredentials.provider, ANIMESCHEDULE_PROVIDER));
    } else {
      await getDb().insert(externalServiceCredentials).values({ provider: ANIMESCHEDULE_PROVIDER, adminId: current.account.id, tokenCiphertext, metadata: "{}", lastVerifiedAt: now, createdAt: now, updatedAt: now });
    }
    return Response.json({ ok: true, configured: true, source: "settings", lastVerifiedAt: now.toISOString(), updatedAt: now.toISOString() }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ error: "AnimeSchedule 绑定失败", details: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}

export async function DELETE(request: Request) {
  const csrf = csrfFailure(request);
  if (csrf) return csrf;
  const current = await requireAdminSession(request);
  if (current instanceof Response) return current;
  try {
    await getDb().delete(externalServiceCredentials).where(and(eq(externalServiceCredentials.provider, ANIMESCHEDULE_PROVIDER), eq(externalServiceCredentials.adminId, current.account.id)));
    return Response.json({ ok: true, configured: hasEnvironmentAnimeScheduleToken(), source: hasEnvironmentAnimeScheduleToken() ? "environment" : null });
  } catch (error) {
    return Response.json({ error: "AnimeSchedule 解绑失败", details: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

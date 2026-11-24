import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../db";
import { externalServiceCredentials } from "../../db/schema";
import { csrfFailure, requireAdminSession } from "./admin-auth";
import { decryptCredential, encryptCredential } from "./bangumi-account";
import { isBackupComponentEnabledValue } from "./backup-providers";

const PROVIDER = "baidu";
export const BAIDU_PENDING_PROVIDER = "baidu-oauth-pending";
const CALLBACK = "/api/backup/providers/baidu";
const AUTHORIZATION = "https://openapi.baidu.com/oauth/2.0/authorize";
const TOKEN = "https://openapi.baidu.com/oauth/2.0/token";
const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer" };
const pendingLifetime = 10 * 60 * 1000;
type Application = { appKey: string; secretKey: string };
type Pending = Application & { state: string; sessionId: number; redirectUri: string; expiresAt: number };
type Authorization = Application & { accessToken: string; refreshToken: string; expiresAt: number };

export function baiduCallbackUrl(request: Request) {
  return new URL(CALLBACK, request.url).href;
}
function enabled() {
  return isBackupComponentEnabledValue((env as typeof env & { BACKUP_COMPONENT_ENABLED?: string }).BACKUP_COMPONENT_ENABLED);
}
function failure(error: string, status: number) {
  return Response.json({ error }, { status, headers });
}
function returnToSettings(request: Request, result: "success" | "cancelled" | "invalid" | "failed") {
  const target = new URL("/settings/security", request.url);
  target.searchParams.set("baidu", result);
  target.hash = "backup-cloud";
  return new Response(null, { status: 303, headers: { ...headers, location: target.href } });
}
function key(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value.trim()) ? value.trim() : "";
}
async function credential(provider: string, adminId: number) {
  const [row] = await getDb().select().from(externalServiceCredentials).where(and(
    eq(externalServiceCredentials.provider, provider), eq(externalServiceCredentials.adminId, adminId),
  )).limit(1);
  return row;
}
async function removePending(adminId: number, ciphertext: string) {
  await getDb().delete(externalServiceCredentials).where(and(
    eq(externalServiceCredentials.provider, BAIDU_PENDING_PROVIDER),
    eq(externalServiceCredentials.adminId, adminId),
    eq(externalServiceCredentials.tokenCiphertext, ciphertext),
  ));
}

/** Start only from an authenticated same-origin POST, never from an arbitrary URL. */
export async function startBaiduBackupOAuth(request: Request) {
  const csrf = csrfFailure(request);
  if (csrf) return csrf;
  const current = await requireAdminSession(request);
  if (current instanceof Response) return current;
  if (current.account.mustChangePassword) return failure("请先修改临时密码", 403);
  if (!enabled()) return failure("备份组件已关闭", 404);
  try {
    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) return failure("请填写百度应用配置", 400);
    const value = body as Record<string, unknown>;
    let appKey = key(value.appKey), secretKey = key(value.secretKey);
    if (value.reuse === true) {
      const saved = await credential(PROVIDER, current.account.id);
      if (!saved) return failure("请先填写 AppKey 和 SecretKey", 400);
      const old = JSON.parse(await decryptCredential(saved.tokenCiphertext)) as Authorization;
      appKey = key(old.appKey);
      secretKey = key(old.secretKey);
    }
    if (!appKey || !secretKey) return failure("请填写有效的 AppKey 和 SecretKey", 400);
    const pending: Pending = {
      appKey, secretKey, sessionId: current.session.id,
      state: crypto.randomUUID() + crypto.randomUUID(),
      redirectUri: baiduCallbackUrl(request), expiresAt: Date.now() + pendingLifetime,
    };
    const ciphertext = await encryptCredential(JSON.stringify(pending));
    const now = new Date();
    await getDb().insert(externalServiceCredentials).values({
      provider: BAIDU_PENDING_PROVIDER, adminId: current.account.id, tokenCiphertext: ciphertext,
      metadata: "{}", createdAt: now, updatedAt: now,
    }).onConflictDoUpdate({ target: externalServiceCredentials.provider, set: {
      adminId: current.account.id, tokenCiphertext: ciphertext, metadata: "{}", updatedAt: now,
    } });
    const url = new URL(AUTHORIZATION);
    url.search = new URLSearchParams({
      response_type: "code", client_id: appKey, redirect_uri: pending.redirectUri,
      scope: "basic,netdisk", state: pending.state,
    }).toString();
    return Response.json({ ok: true, authorizationUrl: url.href }, { headers });
  } catch {
    return failure("无法发起百度网盘授权，请检查网站凭据加密配置后重试。", 500);
  }
}

/** The state is encrypted at rest, bound to one browser Session, time-limited
 * and claimed atomically before exchange. A newer attempt or unlink cancels
 * the old one; no upstream response, authorization code or secret is logged.
 */
export async function finishBaiduBackupOAuth(request: Request, exchange: typeof fetch = fetch) {
  const current = await requireAdminSession(request);
  if (current instanceof Response) return current;
  if (current.account.mustChangePassword) return failure("请先修改临时密码", 403);
  if (!enabled()) return failure("备份组件已关闭", 404);
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  if (!state || state.length > 128) return returnToSettings(request, "invalid");
  let ciphertext: string | undefined;
  try {
    const row = await credential(BAIDU_PENDING_PROVIDER, current.account.id);
    if (!row || row.metadata !== "{}") return returnToSettings(request, "invalid");
    const pending = JSON.parse(await decryptCredential(row.tokenCiphertext)) as Pending;
    if (pending.state !== state || pending.sessionId !== current.session.id ||
        pending.redirectUri !== baiduCallbackUrl(request)) return returnToSettings(request, "invalid");
    if (pending.expiresAt <= Date.now()) {
      await removePending(current.account.id, row.tokenCiphertext);
      return returnToSettings(request, "invalid");
    }
    // Compare-and-set: only one callback can exchange the authorization code.
    const [claimed] = await getDb().update(externalServiceCredentials).set({ metadata: "exchanging" }).where(and(
      eq(externalServiceCredentials.provider, BAIDU_PENDING_PROVIDER),
      eq(externalServiceCredentials.adminId, current.account.id),
      eq(externalServiceCredentials.tokenCiphertext, row.tokenCiphertext),
      eq(externalServiceCredentials.metadata, "{}"),
    )).returning({ provider: externalServiceCredentials.provider });
    if (!claimed) return returnToSettings(request, "invalid");
    ciphertext = row.tokenCiphertext;
    const code = url.searchParams.get("code");
    if (url.searchParams.has("error") || !code || code.length > 4096) {
      await removePending(current.account.id, ciphertext);
      return returnToSettings(request, "cancelled");
    }
    const response = await exchange(TOKEN, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code", code, client_id: pending.appKey,
        client_secret: pending.secretKey, redirect_uri: pending.redirectUri,
      }),
    });
    const payload = await response.json() as Record<string, unknown>;
    if (!response.ok || payload.error || typeof payload.access_token !== "string" || !payload.access_token ||
        typeof payload.refresh_token !== "string" || !payload.refresh_token ||
        payload.access_token.length > 8192 || payload.refresh_token.length > 8192 ||
        typeof payload.expires_in !== "number" || !Number.isFinite(payload.expires_in) ||
        payload.expires_in <= 0 ||
        (typeof payload.scope === "string" && !payload.scope.split(/[\s,]+/).includes("netdisk"))) {
      throw new Error("Baidu authorization failed");
    }
    const now = Date.now();
    const authorized: Authorization = {
      appKey: pending.appKey, secretKey: pending.secretKey, accessToken: payload.access_token,
      refreshToken: payload.refresh_token, expiresAt: now + payload.expires_in * 1000,
    };
    const sealed = await encryptCredential(JSON.stringify(authorized));
    // Both statements run atomically. An unlink or new start during exchange
    // removes/replaces the claimed row and makes this conditional insert a no-op.
    const [saved] = await env.DB.batch([
      env.DB.prepare("INSERT INTO external_service_credentials (provider,admin_id,token_ciphertext,metadata,last_verified_at,created_at,updated_at) SELECT ?,?,?,?,?,?,? FROM external_service_credentials WHERE provider=? AND admin_id=? AND token_ciphertext=? AND metadata='exchanging' ON CONFLICT(provider) DO UPDATE SET admin_id=excluded.admin_id,token_ciphertext=excluded.token_ciphertext,metadata=excluded.metadata,last_verified_at=excluded.last_verified_at,updated_at=excluded.updated_at")
        .bind(PROVIDER, current.account.id, sealed, JSON.stringify({ expiresAt: authorized.expiresAt }), now, now, now, BAIDU_PENDING_PROVIDER, current.account.id, ciphertext),
      env.DB.prepare("DELETE FROM external_service_credentials WHERE provider=? AND admin_id=? AND token_ciphertext=? AND metadata='exchanging'")
        .bind(BAIDU_PENDING_PROVIDER, current.account.id, ciphertext),
    ]);
    return returnToSettings(request, saved.success && Number(saved.meta.changes) === 1 ? "success" : "invalid");
  } catch {
    if (ciphertext) await removePending(current.account.id, ciphertext).catch(() => undefined);
    return returnToSettings(request, "failed");
  }
}

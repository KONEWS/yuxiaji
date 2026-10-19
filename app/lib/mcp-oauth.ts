import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { getDb } from "../../db";
import { mcpOAuthClients, mcpOAuthCodes, mcpOAuthGrants, mcpOAuthTokens } from "../../db/schema";
import { csrfFailure, getAdminSession } from "./admin-auth";
import { getCurrentUser } from "./current-user";

const SCOPES = ["content:read", "content:write", "content:delete", "offline_access"] as const;
const ACCESS_SECONDS = 3600;
const REFRESH_SECONDS = 30 * 86400;
const CODE_SECONDS = 300;
const MAX_BODY_BYTES = 16 * 1024;
const OAUTH_PATHS = new Set([
  "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server", "/api/mcp/oauth/register",
  "/api/mcp/oauth/token", "/api/mcp/oauth/revoke", "/connect/chatgpt", "/connect/chatgpt/manage",
]);

type Grant = typeof mcpOAuthGrants.$inferSelect;
type BrowserSession = NonNullable<Awaited<ReturnType<typeof getAdminSession>>>;
type Authorization = {
  clientId: string; clientName: string; redirectUri: string; resource: string;
  scopes: string[]; challenge: string; state: string | null;
};

class OAuthError extends Error {
  constructor(public code: string, description: string, public status = 400) { super(description); }
}

function headers(cors = false) {
  const value = new Headers({ "cache-control": "no-store", pragma: "no-cache", "referrer-policy": "no-referrer" });
  if (cors) value.set("access-control-allow-origin", "*");
  return value;
}

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: headers(true) });
}

function oauthError(code: string, description: string, status = 400) {
  return json({ error: code, error_description: description }, status);
}

function base64url(bytes: Uint8Array) {
  let result = "";
  for (const byte of bytes) result += String.fromCharCode(byte);
  return btoa(result).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function opaque(prefix: string) {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return prefix + base64url(bytes);
}

async function digest(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return { hex: Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""), url: base64url(bytes) };
}

function resource(request: Request) { return new URL(request.url).origin + "/mcp"; }
function escape(value: string) { return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!)); }

function html(title: string, body: string, status = 200) {
  const responseHeaders = headers();
  // Chromium can send Origin: null for form POSTs under no-referrer. Keep
  // same-origin form provenance while suppressing referrers to ChatGPT.
  responseHeaders.set("referrer-policy", "same-origin");
  responseHeaders.set("content-type", "text/html; charset=utf-8");
  responseHeaders.set("x-content-type-options", "nosniff");
  responseHeaders.set("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://chatgpt.com; base-uri 'none'; frame-ancestors 'none'");
  return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · 月下集</title><style>body{margin:0;background:#f5f7fb;color:#1f2937;font:16px/1.65 system-ui,sans-serif}main{max-width:640px;margin:8vh auto;padding:32px;background:white;border-radius:20px;box-shadow:0 8px 32px #16324f14}h1{font-size:26px}h2{font-size:18px}p{overflow-wrap:anywhere}small{color:#64748b}button,a{font:inherit}button{cursor:pointer;border:0;border-radius:10px;padding:10px 18px;background:#376fa5;color:#fff}button.secondary{background:#e8edf4;color:#374151}form{margin:18px 0}.actions{display:flex;gap:12px}.grant{border-top:1px solid #e5e7eb;padding:18px 0}a{color:#376fa5}@media(max-width:680px){main{margin:24px 12px;padding:24px}}</style></head><body><main>${body}</main></body></html>`, { status, headers: responseHeaders });
}

function redirect(url: URL) {
  const responseHeaders = headers();
  responseHeaders.set("location", url.toString());
  return new Response(null, { status: 302, headers: responseHeaders });
}

async function bodyText(request: Request) {
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) throw new OAuthError("invalid_request", "Request body is too large", 413);
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new OAuthError("invalid_request", "Request body is too large", 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(data); }
  catch { throw new OAuthError("invalid_request", "Request body must be valid UTF-8"); }
}

function unique(params: URLSearchParams) {
  for (const name of params.keys()) {
    if (params.getAll(name).length !== 1) throw new OAuthError("invalid_request", `Repeated parameter: ${name}`);
  }
  return params;
}

async function form(request: Request) {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/x-www-form-urlencoded") throw new OAuthError("invalid_request", "Use application/x-www-form-urlencoded", 415);
  return unique(new URLSearchParams(await bodyText(request)));
}

function required(params: URLSearchParams, name: string, max = 2048) {
  const value = params.get(name);
  if (!value || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new OAuthError("invalid_request", `Missing or invalid ${name}`);
  return value;
}

function parseScopes(input: string | null, fallback: string[] = ["content:read"]) {
  if (input === null) return [...fallback];
  if (input.length > 256) throw new OAuthError("invalid_scope", "Scope is too long");
  const scopes = [...new Set(input.trim().split(/ +/).filter(Boolean))];
  if (!scopes.length || scopes.some((scope) => !(SCOPES as readonly string[]).includes(scope))) throw new OAuthError("invalid_scope", "Only content:read, content:write, content:delete and offline_access are supported");
  if (!scopes.includes("content:read")) throw new OAuthError("invalid_scope", "content:read is required to initialize the content connector; content:write, content:delete and offline_access are optional");
  return scopes;
}

function storedScopes(value: string): string[] {
  const scopes: unknown = JSON.parse(value);
  if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === "string" && (SCOPES as readonly string[]).includes(scope))) throw new Error("Invalid stored OAuth scopes");
  return scopes;
}

function allowedRedirect(value: string) {
  if (value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.origin === "https://chatgpt.com" && !url.username && !url.password && !url.search && !url.hash && url.href === value &&
      (url.pathname === "/connector_platform_oauth_redirect" || /^\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(url.pathname));
  } catch { return false; }
}

async function registerClient(request: Request) {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") throw new OAuthError("invalid_request", "Use application/json", 415);
  let value: unknown;
  try { value = JSON.parse(await bodyText(request)); } catch (error) {
    if (error instanceof OAuthError) throw error;
    throw new OAuthError("invalid_client_metadata", "Invalid JSON body");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OAuthError("invalid_client_metadata", "Invalid client metadata");
  const client = value as Record<string, unknown>;
  if (!Array.isArray(client.redirect_uris) || !client.redirect_uris.length || client.redirect_uris.length > 10 || !client.redirect_uris.every((uri) => typeof uri === "string" && allowedRedirect(uri))) throw new OAuthError("invalid_redirect_uri", "Only the supported ChatGPT HTTPS callbacks can be registered");
  if (client.token_endpoint_auth_method !== undefined && client.token_endpoint_auth_method !== "none") throw new OAuthError("invalid_client_metadata", "Only public clients with token_endpoint_auth_method=none are supported");
  if (client.grant_types !== undefined && (!Array.isArray(client.grant_types) || !client.grant_types.length || !client.grant_types.every((type) => type === "authorization_code" || type === "refresh_token"))) throw new OAuthError("invalid_client_metadata", "Unsupported grant_types");
  if (client.response_types !== undefined && (!Array.isArray(client.response_types) || client.response_types.length !== 1 || client.response_types[0] !== "code")) throw new OAuthError("invalid_client_metadata", "Only the code response type is supported");
  const name = client.client_name === undefined ? "ChatGPT" : client.client_name;
  if (typeof name !== "string" || !name.trim() || name.length > 120 || /[\x00-\x1f\x7f]/.test(name)) throw new OAuthError("invalid_client_metadata", "Invalid client_name");
  const redirectUris = [...new Set(client.redirect_uris as string[])];
  const clientId = opaque("yx_client_");
  const now = new Date();
  await getDb().insert(mcpOAuthClients).values({ clientId, clientName: name.trim(), redirectUrisJson: JSON.stringify(redirectUris), createdAt: now });
  return json({ client_id: clientId, client_id_issued_at: Math.floor(now.getTime() / 1000), client_name: name.trim(), redirect_uris: redirectUris, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }, 201);
}

async function authorization(request: Request): Promise<Authorization> {
  const url = new URL(request.url);
  if (url.search.length > 8192) throw new OAuthError("invalid_request", "Authorization query is too large");
  const params = unique(url.searchParams);
  if (required(params, "response_type", 32) !== "code") throw new OAuthError("unsupported_response_type", "Only code is supported");
  const clientId = required(params, "client_id", 160);
  const [client] = await getDb().select().from(mcpOAuthClients).where(eq(mcpOAuthClients.clientId, clientId)).limit(1);
  if (!client) throw new OAuthError("invalid_client", "Unknown client_id");
  const redirectUri = required(params, "redirect_uri");
  if (!allowedRedirect(redirectUri) || !(JSON.parse(client.redirectUrisJson) as string[]).includes(redirectUri)) throw new OAuthError("invalid_request", "redirect_uri does not match the registered client");
  const target = required(params, "resource");
  if (target !== resource(request)) throw new OAuthError("invalid_target", "resource must be this server's exact /mcp URL");
  if (required(params, "code_challenge_method", 16) !== "S256") throw new OAuthError("invalid_request", "S256 PKCE is required");
  const challenge = required(params, "code_challenge", 43);
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) throw new OAuthError("invalid_request", "Invalid S256 code_challenge");
  const state = params.get("state");
  if (state !== null && (!state || state.length > 1024 || /[\x00-\x1f\x7f]/.test(state))) throw new OAuthError("invalid_request", "Invalid state");
  return { clientId, clientName: client.clientName, redirectUri, resource: target, scopes: parseScopes(params.get("scope")), challenge, state };
}

async function admin(request: Request): Promise<BrowserSession | Response> {
  const current = await getAdminSession(request);
  const url = new URL(request.url);
  if (!current) return redirect(new URL(`/login?next=${encodeURIComponent(url.pathname + url.search)}`, url));
  if (current.account.mustChangePassword) return redirect(new URL("/settings/security?force=1", url));
  return current;
}

async function csrfSignature(request: Request, current: BrowserSession, payload: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(current.session.sessionTokenHash), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const url = new URL(request.url);
  const data = new TextEncoder().encode(`${current.session.id}|${url.pathname}${url.search}|${payload}`);
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, data)));
}

async function csrfToken(request: Request, current: BrowserSession) {
  const payload = `${Date.now() + 10 * 60 * 1000}.${opaque("")}`;
  return `${payload}.${await csrfSignature(request, current, payload)}`;
}

async function validCsrf(request: Request, current: BrowserSession, token: string | null) {
  if (!token || token.length > 200) return false;
  const [expiresText, nonce, signature, extra] = token.split(".");
  const expires = Number(expiresText);
  if (extra !== undefined || !/^\d{13}$/.test(expiresText) || !/^[A-Za-z0-9_-]{43}$/.test(nonce || "") || !/^[A-Za-z0-9_-]{43}$/.test(signature || "") || !Number.isSafeInteger(expires) || expires <= Date.now() || expires > Date.now() + 10 * 60 * 1000) return false;
  const expected = await csrfSignature(request, current, `${expiresText}.${nonce}`);
  let mismatch = 0;
  for (let index = 0; index < expected.length; index++) mismatch |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
  return mismatch === 0;
}

function permissionList(scopes: string[]) {
  return `<ul>${scopes.includes("content:read") ? "<li>查看收藏条目、详情和藏品内容。</li>" : ""}${scopes.includes("content:write") ? "<li>新增和编辑收藏条目、备注、评分、标签及藏品内容。</li>" : ""}${scopes.includes("content:delete") ? "<li><strong>永久删除</strong>指定媒体收藏、藏品或存储关联；可能同时删除关联的展示图片和记录，不能撤销。</li>" : ""}${scopes.includes("offline_access") ? "<li>保持连接，供后续 ChatGPT 会话继续使用；可随时撤销。</li>" : ""}</ul>`;
}

async function consent(request: Request) {
  const auth = await authorization(request);
  if (request.method === "POST") {
    const failure = csrfFailure(request);
    if (failure) return failure;
  }
  const current = await admin(request);
  if (current instanceof Response) return current;
  if (request.method === "GET") {
    const csrf = await csrfToken(request, current);
    return html("连接 ChatGPT", `<h1>将月下集连接到 ChatGPT</h1><p>应用 <strong>${escape(auth.clientName)}</strong> 请求访问你的月下集内容。</p>${permissionList(auth.scopes)}<p>此连接仅开放内容操作。源码、部署、账户安全设置、密码和集成凭据均不向连接开放。</p><p><small>授权后使用独立令牌，访问令牌有效期为 1 小时。${auth.scopes.includes("offline_access") ? "续期令牌有效期为 30 天，每次续期会更换。" : "本次授权不提供续期令牌。"}</small></p><form method="post"><input type="hidden" name="csrf_token" value="${escape(csrf)}"><div class="actions"><button name="decision" value="allow" type="submit">同意连接</button><button name="decision" value="deny" class="secondary" type="submit">拒绝</button></div></form><p><a href="/connect/chatgpt/manage">管理已有连接</a></p>`);
  }
  const params = await form(request);
  if (!await validCsrf(request, current, params.get("csrf_token"))) return html("授权失败", "<h1>授权失败</h1><p>页面已过期或 CSRF 校验失败，请刷新授权页面后重试。</p>", 403);
  const decision = required(params, "decision", 16);
  if (decision !== "allow" && decision !== "deny") throw new OAuthError("invalid_request", "Choose allow or deny");
  const callback = new URL(auth.redirectUri);
  if (auth.state !== null) callback.searchParams.set("state", auth.state);
  callback.searchParams.set("iss", new URL(request.url).origin);
  if (decision === "deny") {
    callback.searchParams.set("error", "access_denied");
    return redirect(callback);
  }
  const code = opaque("yx_code_");
  const grantId = opaque("yx_grant_");
  const now = new Date();
  await getDb().batch([
    getDb().insert(mcpOAuthGrants).values({ id: grantId, userKey: getCurrentUser(), clientId: auth.clientId, resource: auth.resource, scopesJson: JSON.stringify(auth.scopes), createdAt: now }),
    getDb().insert(mcpOAuthCodes).values({ codeHash: (await digest(code)).hex, grantId, clientId: auth.clientId, redirectUri: auth.redirectUri, resource: auth.resource, codeChallenge: auth.challenge, scopesJson: JSON.stringify(auth.scopes), expiresAt: new Date(now.getTime() + CODE_SECONDS * 1000) }),
  ]);
  callback.searchParams.set("code", code);
  return redirect(callback);
}

async function activeGrant(id: string, clientId: string, target: string) {
  const [grant] = await getDb().select().from(mcpOAuthGrants).where(and(eq(mcpOAuthGrants.id, id), eq(mcpOAuthGrants.clientId, clientId), eq(mcpOAuthGrants.resource, target), eq(mcpOAuthGrants.userKey, getCurrentUser()), isNull(mcpOAuthGrants.revokedAt))).limit(1);
  return grant;
}

async function revokeGrant(id: string) {
  await getDb().update(mcpOAuthGrants).set({ revokedAt: new Date() }).where(and(eq(mcpOAuthGrants.id, id), isNull(mcpOAuthGrants.revokedAt)));
}

async function issueTokens(grant: Grant, scopes: string[]) {
  const accessToken = opaque("yx_access_");
  const refreshToken = scopes.includes("offline_access") ? opaque("yx_refresh_") : null;
  const now = new Date();
  const base = { grantId: grant.id, clientId: grant.clientId, resource: grant.resource, scopesJson: JSON.stringify(scopes), createdAt: now };
  const rows = [{ ...base, tokenHash: (await digest(accessToken)).hex, tokenType: "access", expiresAt: new Date(now.getTime() + ACCESS_SECONDS * 1000) }];
  if (refreshToken) rows.push({ ...base, tokenHash: (await digest(refreshToken)).hex, tokenType: "refresh", expiresAt: new Date(now.getTime() + REFRESH_SECONDS * 1000) });
  await getDb().batch([
    getDb().insert(mcpOAuthTokens).values(rows),
    getDb().update(mcpOAuthGrants).set({ lastUsedAt: now }).where(eq(mcpOAuthGrants.id, grant.id)),
  ]);
  return json({ access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_SECONDS, scope: scopes.join(" "), ...(refreshToken ? { refresh_token: refreshToken } : {}) });
}

async function exchangeToken(request: Request) {
  const params = await form(request);
  if (request.headers.has("authorization") || params.has("client_secret")) throw new OAuthError("invalid_client", "Only unauthenticated public clients with PKCE are supported", 401);
  const clientId = required(params, "client_id", 160);
  const target = required(params, "resource");
  if (target !== resource(request)) throw new OAuthError("invalid_target", "resource must be this server's exact /mcp URL");
  const type = required(params, "grant_type", 32);
  if (type === "authorization_code") {
    const code = required(params, "code", 160);
    const redirectUri = required(params, "redirect_uri");
    const verifier = required(params, "code_verifier", 128);
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new OAuthError("invalid_grant", "Invalid PKCE verifier");
    const [row] = await getDb().select().from(mcpOAuthCodes).where(eq(mcpOAuthCodes.codeHash, (await digest(code)).hex)).limit(1);
    if (!row || row.clientId !== clientId || row.redirectUri !== redirectUri || row.resource !== target || row.expiresAt.getTime() <= Date.now() || row.codeChallenge !== (await digest(verifier)).url) throw new OAuthError("invalid_grant", "Invalid, expired or mismatched authorization code");
    const grant = await activeGrant(row.grantId, clientId, target);
    if (!grant) throw new OAuthError("invalid_grant", "Authorization was revoked");
    const [consumed] = await getDb().update(mcpOAuthCodes).set({ consumedAt: new Date() }).where(and(eq(mcpOAuthCodes.codeHash, row.codeHash), isNull(mcpOAuthCodes.consumedAt), gt(mcpOAuthCodes.expiresAt, new Date()))).returning({ grantId: mcpOAuthCodes.grantId });
    if (!consumed) {
      const [fresh] = await getDb().select({ consumedAt: mcpOAuthCodes.consumedAt }).from(mcpOAuthCodes).where(eq(mcpOAuthCodes.codeHash, row.codeHash)).limit(1);
      if (fresh?.consumedAt) await revokeGrant(row.grantId);
      throw new OAuthError("invalid_grant", "Authorization code has already been used or expired");
    }
    return issueTokens(grant, storedScopes(row.scopesJson));
  }
  if (type === "refresh_token") {
    const token = required(params, "refresh_token", 160);
    const [row] = await getDb().select().from(mcpOAuthTokens).where(and(eq(mcpOAuthTokens.tokenHash, (await digest(token)).hex), eq(mcpOAuthTokens.tokenType, "refresh"))).limit(1);
    if (!row || row.clientId !== clientId || row.resource !== target) throw new OAuthError("invalid_grant", "Invalid refresh token");
    const grant = await activeGrant(row.grantId, clientId, target);
    if (!grant) throw new OAuthError("invalid_grant", "Authorization was revoked");
    if (row.usedAt) {
      await revokeGrant(row.grantId);
      throw new OAuthError("invalid_grant", "Refresh token replay detected; reconnect this account");
    }
    if (row.expiresAt.getTime() <= Date.now()) throw new OAuthError("invalid_grant", "Refresh token has expired");
    const previous = storedScopes(row.scopesJson);
    const scopes = parseScopes(params.get("scope"), previous);
    if (scopes.some((scope) => !previous.includes(scope))) throw new OAuthError("invalid_scope", "Refresh cannot expand the granted scope");
    const [consumed] = await getDb().update(mcpOAuthTokens).set({ usedAt: new Date() }).where(and(eq(mcpOAuthTokens.tokenHash, row.tokenHash), isNull(mcpOAuthTokens.usedAt), gt(mcpOAuthTokens.expiresAt, new Date()))).returning({ grantId: mcpOAuthTokens.grantId });
    if (!consumed) {
      await revokeGrant(row.grantId);
      throw new OAuthError("invalid_grant", "Refresh token has already been used or expired");
    }
    return issueTokens(grant, scopes);
  }
  throw new OAuthError("unsupported_grant_type", "Only authorization_code and refresh_token are supported");
}

async function revokeToken(request: Request) {
  const params = await form(request);
  const clientId = required(params, "client_id", 160);
  const token = required(params, "token", 160);
  if (params.has("resource") && params.get("resource") !== resource(request)) throw new OAuthError("invalid_target", "Incorrect resource");
  const [row] = await getDb().select().from(mcpOAuthTokens).where(and(eq(mcpOAuthTokens.tokenHash, (await digest(token)).hex), eq(mcpOAuthTokens.clientId, clientId), eq(mcpOAuthTokens.resource, resource(request)))).limit(1);
  if (row) await revokeGrant(row.grantId);
  return new Response(null, { status: 200, headers: headers(true) });
}

async function manage(request: Request) {
  if (request.method === "POST") {
    const failure = csrfFailure(request);
    if (failure) return failure;
  }
  const current = await admin(request);
  if (current instanceof Response) return current;
  const owner = getCurrentUser();
  if (request.method === "POST") {
    const params = await form(request);
    if (!await validCsrf(request, current, params.get("csrf_token"))) return html("管理连接", "<h1>撤销失败</h1><p>页面已过期或 CSRF 校验失败，请刷新后重试。</p>", 403);
    const grantId = required(params, "grant_id", 160);
    if (required(params, "action", 16) !== "revoke") throw new OAuthError("invalid_request", "Unsupported action");
    await getDb().update(mcpOAuthGrants).set({ revokedAt: new Date() }).where(and(eq(mcpOAuthGrants.id, grantId), eq(mcpOAuthGrants.userKey, owner), isNull(mcpOAuthGrants.revokedAt)));
    return redirect(new URL("/connect/chatgpt/manage", request.url));
  }
  const grants = await getDb().select({ grant: mcpOAuthGrants, clientName: mcpOAuthClients.clientName }).from(mcpOAuthGrants).innerJoin(mcpOAuthClients, eq(mcpOAuthGrants.clientId, mcpOAuthClients.clientId)).where(and(eq(mcpOAuthGrants.userKey, owner), isNull(mcpOAuthGrants.revokedAt))).orderBy(desc(mcpOAuthGrants.createdAt));
  const csrf = await csrfToken(request, current);
  const rows = grants.map(({ grant, clientName }) => `<section class="grant"><h2>${escape(clientName)}</h2><p><small>授权时间：${escape(grant.createdAt.toLocaleString("zh-CN", { timeZone: "Asia/Hong_Kong" }))}（香港时间）</small></p>${permissionList(storedScopes(grant.scopesJson))}${grant.revokedAt ? "<p>已撤销</p>" : `<form method="post"><input type="hidden" name="csrf_token" value="${escape(csrf)}"><input type="hidden" name="grant_id" value="${escape(grant.id)}"><button type="submit" name="action" value="revoke">撤销连接</button></form>`}</section>`).join("");
  return html("管理 ChatGPT 连接", `<h1>管理 ChatGPT 连接</h1><p>以下列出所有未撤销的连接。撤销后，该授权的访问令牌和续期令牌立即失效。后续使用需要重新登录并授权。</p>${rows || "<p>目前没有未撤销的连接。</p>"}<p><a href="/">返回月下集</a></p>`);
}

/** Exact OAuth routes run before the browser guard; consent still requires it. */
export async function handleMcpOAuth(request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  if (!OAUTH_PATHS.has(url.pathname)) return null;
  const browserPage = url.pathname === "/connect/chatgpt" || url.pathname === "/connect/chatgpt/manage";
  const discovery = url.pathname.startsWith("/.well-known/");
  if (request.method === "OPTIONS" && !browserPage) {
    const responseHeaders = headers(true);
    responseHeaders.set("access-control-allow-methods", discovery ? "GET, OPTIONS" : "POST, OPTIONS");
    responseHeaders.set("access-control-allow-headers", "content-type, authorization");
    return new Response(null, { status: 204, headers: responseHeaders });
  }
  const allowed = browserPage ? ["GET", "POST"] : discovery ? ["GET"] : ["POST"];
  if (!allowed.includes(request.method)) {
    const response = oauthError("invalid_request", "Method not allowed", 405);
    response.headers.set("allow", allowed.join(", "));
    return response;
  }
  try {
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return json({ resource: resource(request), authorization_servers: [url.origin], scopes_supported: [...SCOPES], bearer_methods_supported: ["header"], resource_name: "月下集内容连接" });
    if (url.pathname === "/.well-known/oauth-authorization-server") return json({ issuer: url.origin, authorization_endpoint: url.origin + "/connect/chatgpt", token_endpoint: url.origin + "/api/mcp/oauth/token", registration_endpoint: url.origin + "/api/mcp/oauth/register", revocation_endpoint: url.origin + "/api/mcp/oauth/revoke", response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], token_endpoint_auth_methods_supported: ["none"], revocation_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"], scopes_supported: [...SCOPES], authorization_response_iss_parameter_supported: true });
    if (url.pathname === "/api/mcp/oauth/register") return await registerClient(request);
    if (url.pathname === "/api/mcp/oauth/token") return await exchangeToken(request);
    if (url.pathname === "/api/mcp/oauth/revoke") return await revokeToken(request);
    if (url.pathname === "/connect/chatgpt") return await consent(request);
    return await manage(request);
  } catch (error) {
    if (error instanceof OAuthError) return browserPage ? html("连接失败", `<h1>连接失败</h1><p>${escape(error.message)}</p><p><a href="/connect/chatgpt/manage">管理连接</a></p>`, error.status) : oauthError(error.code, error.message, error.status);
    return browserPage ? html("连接服务暂不可用", "<h1>连接服务暂不可用</h1><p>请稍后重试。</p>", 503) : oauthError("server_error", "OAuth service is temporarily unavailable", 503);
  }
}

/** MCP accepts its own opaque access tokens only, never browser or Agent auth. */
export async function authenticateMcpRequest(request: Request): Promise<{ grantId: string; userKey: string; scopes: string[] } | Response> {
  const unauthorized = (description: string) => {
    const response = oauthError("invalid_token", description, 401);
    response.headers.set("www-authenticate", `Bearer resource_metadata="${new URL(request.url).origin}/.well-known/oauth-protected-resource/mcp", scope="${SCOPES.join(" ")}", error="invalid_token"`);
    return response;
  };
  const value = request.headers.get("authorization");
  const token = value?.match(/^Bearer (yx_access_[A-Za-z0-9_-]{43})$/i)?.[1];
  if (!token) return unauthorized("A content-connector OAuth access token is required");
  try {
    const [row] = await getDb().select().from(mcpOAuthTokens).where(and(eq(mcpOAuthTokens.tokenHash, (await digest(token)).hex), eq(mcpOAuthTokens.tokenType, "access"), eq(mcpOAuthTokens.resource, resource(request)))).limit(1);
    if (!row || row.expiresAt.getTime() <= Date.now()) return unauthorized("Access token is invalid or expired");
    const grant = await activeGrant(row.grantId, row.clientId, resource(request));
    if (!grant) return unauthorized("This content authorization has been revoked");
    const scopes = storedScopes(row.scopesJson);
    const grantedScopes = storedScopes(grant.scopesJson);
    if (scopes.some((scope) => !grantedScopes.includes(scope))) return unauthorized("Access token scopes are invalid");
    return { grantId: grant.id, userKey: grant.userKey, scopes };
  } catch { return oauthError("server_error", "Authentication service is temporarily unavailable", 503); }
}

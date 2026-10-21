import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import wrangler from "wrangler";

const { unstable_splitSqlQuery: splitSqlQuery, unstable_dev } = wrangler;
const CALLBACK = "https://chatgpt.com/connector_platform_oauth_redirect";
const FULL_SCOPE = "content:read content:write offline_access";
let worker;
let origin;
let resource;
let adminCookie;
let writable;
let readable;
let deletable;
let rpcId = 0;

// Assertions deliberately avoid logging OAuth credentials, even on failure.
async function fetchLocal(path, init = {}) {
  return worker.fetch(path, { redirect: "manual", ...init });
}
async function jsonRequest(path, body, headers = {}) {
  return fetchLocal(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}
async function sql(statements) {
  const response = await jsonRequest("/__test/sql", statements);
  assert.equal(response.status, 200, "fixture SQL executes against local D1");
}
async function query(statement, params = []) {
  const response = await jsonRequest("/__test/query", { statement, params });
  assert.equal(response.status, 200, "fixture query executes against local D1");
  return response.json();
}
function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}
async function register(redirectUri = CALLBACK) {
  const response = await jsonRequest("/api/mcp/oauth/register", {
    client_name: "Isolated MCP test", redirect_uris: [redirectUri], token_endpoint_auth_method: "none",
  });
  assert.equal(response.status, 201, "a permitted ChatGPT client registers");
  const result = await response.json();
  assert.ok(typeof result.client_id === "string" && result.client_id.length > 10, "registration returns a client ID");
  return result.client_id;
}
function authorizeUrl(clientId, challenge, scope = FULL_SCOPE, extra = {}) {
  const params = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: CALLBACK,
    code_challenge: challenge, code_challenge_method: "S256", resource,
    scope, state: "fixture-state", ...extra,
  });
  return `/connect/chatgpt?${params}`;
}
async function consentPage(path, cookie = adminCookie) {
  const response = await fetchLocal(path, { headers: cookie ? { cookie } : {} });
  const html = await response.text();
  return { response, html, csrf: html.match(/name="csrf_token"\s+value="([^"]+)"/)?.[1] ?? html.match(/value="([^"]+)"\s+name="csrf_token"/)?.[1] };
}
async function consent(path, csrf, { cookie = adminCookie, decision = "allow", headers = {} } = {}) {
  return fetchLocal(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie, origin, ...headers },
    body: new URLSearchParams({ decision, ...(csrf ? { csrf_token: csrf } : {}) }).toString(),
  });
}
async function issueCode(scope = FULL_SCOPE, clientId) {
  const client = clientId ?? await register();
  const proof = pkce();
  const path = authorizeUrl(client, proof.challenge, scope);
  const page = await consentPage(path);
  assert.equal(page.response.status, 200, "authenticated consent renders");
  assert.ok(page.csrf, "consent includes a session-bound CSRF value");
  const response = await consent(path, page.csrf);
  assert.equal(response.status, 302, "approval redirects to the registered callback");
  const callback = new URL(response.headers.get("location"));
  assert.equal(callback.origin + callback.pathname, CALLBACK);
  assert.equal(callback.searchParams.get("state"), "fixture-state");
  const code = callback.searchParams.get("code");
  assert.ok(typeof code === "string" && code.length > 20, "approval issues a code");
  return { clientId: client, code, verifier: proof.verifier, scope };
}
async function tokenRequest(params) {
  return fetchLocal("/api/mcp/oauth/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
}
async function exchange(flow, overrides = {}) {
  return tokenRequest({
    grant_type: "authorization_code", client_id: flow.clientId, redirect_uri: CALLBACK,
    code: flow.code, code_verifier: flow.verifier, resource, ...overrides,
  });
}
async function connection(scope = FULL_SCOPE) {
  const flow = await issueCode(scope);
  const response = await exchange(flow);
  assert.equal(response.status, 200, "bound authorization code exchanges successfully");
  const credentials = await response.json();
  assert.ok(typeof credentials.access_token === "string" && credentials.access_token.length > 20, "an access token is issued");
  return { ...credentials, clientId: flow.clientId };
}
async function rpc(method, params = {}, credentials = writable, headers = {}) {
  const response = await jsonRequest("/mcp", { jsonrpc: "2.0", id: ++rpcId, method, params }, {
    ...(credentials?.access_token ? { authorization: `Bearer ${credentials.access_token}` } : {}), ...headers,
  });
  const body = await response.json();
  return { response, body };
}
async function call(name, args = {}, credentials = writable) {
  const { response, body } = await rpc("tools/call", { name, arguments: args }, credentials);
  assert.equal(response.status, 200, "tool call uses a JSON-RPC response");
  return body;
}
function successful(body) {
  assert.ok(!body.error, "JSON-RPC call succeeds");
  assert.ok(body.result && !body.result.isError, "content tool succeeds");
  assert.ok(body.result.structuredContent, "content tool includes structured data");
  return body.result.structuredContent;
}
function toolDenied(body) {
  assert.ok(body.error || body.result?.isError, "operation is rejected before writing");
}

test("music cover tool declares native ChatGPT file inputs and restricts writes before downloads", async () => {
  const listed = await rpc("tools/list");
  const tool = listed.body.result.tools.find((entry) => entry.name === "upload_music_cover");
  assert.deepEqual(tool._meta["openai/fileParams"], ["file"]);
  assert.deepEqual(tool.inputSchema.properties.file.required, ["download_url", "file_id"]);
  assert.deepEqual(Object.keys(tool.inputSchema.properties.file.properties).sort(), ["download_url", "file_id", "file_name", "mime_type"]);
  const media = successful(await call("create_media", { type: "music", title: "Cover permissions", idempotencyKey: "cover-permissions-create" })).media;
  const base = { id: media.id, expectedTitle: media.title, idempotencyKey: "cover-permissions", file: { file_id: "file-fixture", download_url: "https://files.oaiusercontent.com/fixture.webp" } };
  const before = await (await fetchLocal("/__test/image-downloads")).json();
  toolDenied(await call("upload_music_cover", base, readable));
  toolDenied(await call("upload_music_cover", { ...base, expectedTitle: "Wrong song" }));
  toolDenied(await call("upload_music_cover", { ...base, id: 9100, expectedTitle: "Private foreign music" }));
  toolDenied(await call("upload_music_cover", { ...base, file: { ...base.file, token: "not-allowed" } }));
  for (const download_url of ["http://127.0.0.1/private", "https://files.oaiusercontent.com.attacker.invalid/image", "https://files.oaiusercontent.com@evil.invalid/image", "https://files.oaiusercontent.com:444/image"]) {
    toolDenied(await call("upload_music_cover", { ...base, file: { ...base.file, download_url } }));
  }
  const after = await (await fetchLocal("/__test/image-downloads")).json();
  assert.equal(after.count, before.count, "rejected requests never download files");
});

test("music cover upload stores a display image, preserves song fields, reads back and replays without downloading again", async () => {
  const media = successful(await call("create_media", { type: "music", title: "Cover roundtrip", musicArtist: "Artist", musicAlbum: "Album", tags: ["keep"], score: 9, metadata: { duration: "03:42", overview: "Keep overview", coverZoom: 150 }, idempotencyKey: "cover-roundtrip-create" })).media;
  const base = { id: media.id, expectedTitle: media.title, idempotencyKey: "cover-roundtrip", file: { file_id: "file-roundtrip", download_url: "https://files.oaiusercontent.com/fixture.webp?temporary-secret=do-not-log", mime_type: "image/webp", file_name: "cover.webp" } };
  const result = successful(await call("upload_music_cover", base));
  assert.match(result.media.image, /^\/api\/media-assets\?v=\d+$/);
  assert.equal(result.media.musicArtist, "Artist");
  assert.equal(result.media.musicAlbum, "Album");
  assert.deepEqual(result.media.tags, ["keep"]);
  assert.equal(result.media.score, 9);
  assert.equal(result.media.metadata.duration, "03:42");
  assert.equal(result.media.metadata.overview, "Keep overview");
  assert.equal(result.media.metadata.coverZoom, 100);
  const image = await fetchLocal(result.media.image);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/webp");
  assert.equal((await image.arrayBuffer()).byteLength, 16);
  const before = await (await fetchLocal("/__test/image-downloads")).json();
  const replay = successful(await call("upload_music_cover", { ...base, file: { ...base.file, download_url: "https://files.oaiusercontent.com/expired.webp" } }));
  assert.equal(replay.media.image, result.media.image);
  assert.equal((await (await fetchLocal("/__test/image-downloads")).json()).count, before.count);
  toolDenied(await call("upload_music_cover", { ...base, file: { ...base.file, file_id: "file-different" } }));
  const logs = await query("SELECT response_json FROM agent_operations WHERE resource='music_cover'");
  assert.ok(!JSON.stringify(logs).includes("temporary-secret"), "signed URLs never enter operation logs");
  assert.ok(!JSON.stringify(logs).includes("file-roundtrip"), "file references are fingerprinted");
});

test("failed music cover downloads leave the existing cover untouched", async () => {
  const media = successful(await call("create_media", { type: "music", title: "Cover failure", image: "https://example.com/keep.webp", idempotencyKey: "cover-failure-create" })).media;
  for (const [index, path] of ["oversize.webp", "not-image.html"].entries()) {
    toolDenied(await call("upload_music_cover", { id: media.id, expectedTitle: media.title, idempotencyKey: `cover-failure-${index}`, file: { file_id: `file-failure-${index}`, download_url: `https://files.oaiusercontent.com/${path}` } }));
    const saved = successful(await call("get_media", { id: media.id })).media;
    assert.equal(saved.image, media.image);
  }
});
async function refresh(credentials, overrides = {}) {
  return tokenRequest({ grant_type: "refresh_token", client_id: credentials.clientId, refresh_token: credentials.refresh_token, resource, ...overrides });
}

before(async () => {
  worker = await unstable_dev("tests/fixtures/mcp-worker.mjs", {
    config: "tests/fixtures/mcp-wrangler.jsonc", envFiles: ["tests/fixtures/.env.test"],
    persist: false, local: true, logLevel: "error",
    experimental: { disableExperimentalWarning: true, disableDevRegistry: true, showInteractiveDevSession: false, testMode: true, watch: false },
  });
  for (const name of (await readdir("drizzle")).filter((entry) => entry.endsWith(".sql")).sort()) {
    await sql(splitSqlQuery(await readFile(`drizzle/${name}`, "utf8")));
  }
  const setup = await fetchLocal("/__test/setup", { method: "POST" });
  assert.equal(setup.status, 200, "isolated admin account and real hashed session are created");
  origin = (await setup.json()).origin;
  resource = `${origin}/mcp`;
  adminCookie = setup.headers.get("set-cookie").split(";")[0];
  await sql([
    "INSERT INTO user_subjects (id,user_key,type,title,updated_at) VALUES (9100,'another-owner','music','Private foreign music',1)",
    "INSERT INTO user_devices (id,user_key,name,category,updated_at) VALUES (9100,'another-owner','Private foreign device','audio',1)",
  ]);
  writable = await connection();
  readable = await connection("content:read");
  deletable = await connection("content:read content:write content:delete offline_access");
});
after(async () => { await worker?.stop(); });

test("OAuth discovery binds issuer and resource and advertises S256 and offline access", async () => {
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    const response = await fetchLocal(path);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.resource, resource);
    assert.deepEqual(data.authorization_servers, [origin]);
    assert.ok(data.scopes_supported.includes("content:read"));
    assert.ok(data.scopes_supported.includes("content:write"));
  }
  const response = await fetchLocal("/.well-known/oauth-authorization-server");
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.issuer, origin);
  assert.equal(data.authorization_endpoint, `${origin}/connect/chatgpt`);
  assert.equal(data.token_endpoint, `${origin}/api/mcp/oauth/token`);
  assert.deepEqual(data.code_challenge_methods_supported, ["S256"]);
  assert.ok(data.scopes_supported.includes("offline_access"));
  assert.ok(data.scopes_supported.includes("content:delete"));
  assert.ok(data.grant_types_supported.includes("refresh_token"));
});

test("MCP rejects anonymous, browser-session, and existing Agent credentials", async () => {
  for (const headers of [{}, { cookie: adminCookie }, { authorization: "Bearer test-nova-token" }, { authorization: "Bearer test-codex-token" }, { "x-agent-token": "test-hikari-token" }]) {
    const { response } = await rpc("tools/list", {}, null, headers);
    assert.equal(response.status, 401);
    assert.match(response.headers.get("www-authenticate") ?? "", /Bearer/i);
    assert.ok(response.headers.get("www-authenticate")?.includes("oauth-protected-resource"));
  }
});

test("dynamic registration accepts only exact ChatGPT OAuth callback shapes", async () => {
  await register("https://chatgpt.com/connector/oauth/test_123-Ab");
  for (const callback of [
    "http://chatgpt.com/connector_platform_oauth_redirect",
    "https://chatgpt.com.evil.invalid/connector_platform_oauth_redirect",
    "https://chatgpt.com/connector_platform_oauth_redirect?next=https://evil.invalid",
    "https://chatgpt.com/connector_platform_oauth_redirect#fragment",
    "https://user@chatgpt.com/connector_platform_oauth_redirect",
    "https://chatgpt.com:444/connector_platform_oauth_redirect",
    "https://chatgpt.com/anywhere", "https://chatgpt.com/connector/oauth/../elsewhere",
  ]) {
    const response = await jsonRequest("/api/mcp/oauth/register", { redirect_uris: [callback] });
    assert.equal(response.status, 400, callback);
  }
});

test("consent requires admin login and keeps browser session credentials out of HTML", async () => {
  const client = await register();
  const path = authorizeUrl(client, pkce().challenge);
  const anonymous = await consentPage(path, "");
  assert.equal(anonymous.response.status, 302);
  assert.equal(new URL(anonymous.response.headers.get("location"), origin).pathname, "/login");
  const page = await consentPage(path);
  assert.equal(page.response.status, 200);
  assert.ok(page.csrf, "authenticated consent has CSRF protection");
  assert.ok(!page.html.includes(adminCookie.split("=")[1]), "session credential is never embedded in consent");
  assert.match(page.response.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(page.response.headers.get("referrer-policy"), "same-origin", "browser form POST keeps a non-null origin without leaking referrers to ChatGPT");
  assert.match(page.response.headers.get("content-security-policy") ?? "", /form-action 'self' https:\/\/chatgpt\.com(?:;|$)/, "browser policy permits the OAuth POST redirect to ChatGPT");
});

test("consent rejects missing or incorrect CSRF and cross-origin approval, and can decline", async () => {
  const path = authorizeUrl(await register(), pkce().challenge);
  const page = await consentPage(path);
  for (const options of [ { csrf: "" }, { csrf: "invalid-csrf" }, { csrf: page.csrf, headers: { origin: "https://evil.invalid" } } ]) {
    const response = await consent(path, options.csrf, { headers: options.headers });
    assert.equal(response.status, 403);
  }
  const newSession = await fetchLocal("/__test/session", { method: "POST" });
  const anotherCookie = newSession.headers.get("set-cookie").split(";")[0];
  assert.equal((await consent(path, page.csrf, { cookie: anotherCookie })).status, 403, "another valid admin session cannot reuse the original session's CSRF");
  assert.equal((await consent(path.replace("state=fixture-state", "state=different-state"), page.csrf)).status, 403, "CSRF also binds the complete authorization request");
  const denied = await consent(path, page.csrf, { decision: "deny" });
  assert.equal(denied.status, 302);
  const callback = new URL(denied.headers.get("location"));
  assert.equal(callback.searchParams.get("error"), "access_denied");
  assert.ok(!callback.searchParams.has("code"));
});

test("authorization rejects unsupported scopes, weak PKCE, and mismatched resource", async () => {
  const client = await register();
  for (const params of [
    { code_challenge_method: "plain" }, { code_challenge: "short" },
    { scope: "content:read admin:write" }, { resource: "https://evil.invalid/mcp" },
    { redirect_uri: "https://evil.invalid/callback" },
  ]) {
    const response = await fetchLocal(authorizeUrl(client, pkce().challenge, FULL_SCOPE, params), { headers: { cookie: adminCookie } });
    assert.ok(response.status >= 400 || new URL(response.headers.get("location"), origin).searchParams.has("error"), "invalid authorization cannot grant access");
  }
});

test("authorization-code exchange binds PKCE, redirect URI, client, and resource", async () => {
  const wrongClient = await register();
  for (const overrides of [
    { code_verifier: "x".repeat(43) }, { redirect_uri: "https://chatgpt.com/connector/oauth/wrong" },
    { client_id: wrongClient }, { resource: `${origin}/different` },
  ]) {
    const flow = await issueCode();
    const denied = await exchange(flow, overrides);
    assert.equal(denied.status, 400, "an exchange with mismatched binding fails");
    const allowed = await exchange(flow);
    assert.equal(allowed.status, 200, "a failed binding attempt does not consume the legitimate code");
  }
});

test("authorization codes are single-use and read-only grants do not acquire refresh tokens", async () => {
  const flow = await issueCode("content:read");
  const first = await exchange(flow);
  assert.equal(first.status, 200);
  const credentials = await first.json();
  assert.equal(credentials.scope, "content:read");
  assert.ok(!credentials.refresh_token, "offline access must be explicitly approved");
  const again = await exchange(flow);
  assert.equal(again.status, 400, "consumed authorization code is unusable");
  const body = await again.json();
  assert.equal(body.error, "invalid_grant");
});

test("MCP initialization and tool metadata expose content capabilities", async () => {
  const initialized = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "integration-test", version: "1" } });
  assert.equal(initialized.response.status, 200);
  assert.equal(initialized.body.result.protocolVersion, "2025-11-25");
  assert.equal(initialized.body.result.serverInfo.name, "yuexiaji-content");
  assert.deepEqual(initialized.body.result.capabilities, { tools: {} });
  const listed = await rpc("tools/list");
  const names = listed.body.result.tools.map((tool) => tool.name);
  assert.equal(names.length, 17);
  for (const required of ["get_media", "create_media", "update_media", "get_device", "update_device", "list_storage_links"]) assert.ok(names.includes(required));
  for (const required of ["delete_media", "delete_device", "delete_storage_link"]) {
    const tool = listed.body.result.tools.find((item) => item.name === required);
    assert.ok(tool, required);
    assert.equal(tool.annotations.destructiveHint, true);
    assert.ok(tool.securitySchemes[0].scopes.includes("content:delete"));
    assert.ok(!tool.securitySchemes[0].scopes.includes("content:write"), "delete uses an independently granted scope");
  }
  assert.ok(names.every((name) => !/code|deploy|shell|fetch|account/.test(name)), "tools do not expose code or account operations");
  for (const tool of listed.body.result.tools) assert.equal(tool.inputSchema.additionalProperties, false);
  successful(await call("connection_info"));
});

test("MCP reports parse, envelope, method, parameter, and unknown-tool errors", async () => {
  const headers = { "content-type": "application/json", authorization: `Bearer ${writable.access_token}` };
  const parse = await fetchLocal("/mcp", { method: "POST", headers, body: "{" });
  assert.equal(parse.status, 400);
  assert.equal((await parse.json()).error.code, -32700);
  const invalid = await jsonRequest("/mcp", { jsonrpc: "1.0", id: 1, method: "ping" }, headers);
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, -32600);
  assert.equal((await rpc("arbitrary/method")).body.error.code, -32601);
  assert.equal((await rpc("initialize", {})).body.error.code, -32602);
  assert.equal((await call("delete_everything", { id: 9100 })).error.code, -32602);
  const notification = await jsonRequest("/mcp", { jsonrpc: "2.0", method: "notifications/initialized" }, headers);
  assert.equal(notification.status, 202);
  assert.equal(await notification.text(), "");
});

test("transport rejects unsupported methods, origins, media types, versions, and oversized bodies", async () => {
  const authorization = `Bearer ${writable.access_token}`;
  for (const method of ["GET", "DELETE"]) assert.equal((await fetchLocal("/mcp", { method, headers: { authorization } })).status, 405);
  assert.equal((await rpc("ping", {}, writable, { origin: "https://evil.invalid" })).response.status, 403);
  assert.equal((await rpc("ping", {}, writable, { "content-type": "text/plain" })).response.status, 415);
  assert.equal((await rpc("ping", {}, writable, { "mcp-protocol-version": "invalid" })).response.status, 400);
  const oversized = await fetchLocal("/mcp", { method: "POST", headers: { authorization, "content-type": "application/json" }, body: " ".repeat(128 * 1024 + 1) });
  assert.equal(oversized.status, 413);
  const preflight = await fetchLocal("/mcp", { method: "OPTIONS", headers: { origin: "https://chatgpt.com" } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "https://chatgpt.com");
});

test("read-only OAuth connections can read content but cannot write it", async () => {
  successful(await call("search_media", { type: "music" }, readable));
  const beforeCount = (await query("SELECT COUNT(*) AS count FROM user_subjects"))[0].count;
  toolDenied(await call("create_media", { type: "music", title: "Denied read-only creation", idempotencyKey: "readonly-denied" }, readable));
  const afterCount = (await query("SELECT COUNT(*) AS count FROM user_subjects"))[0].count;
  assert.equal(afterCount, beforeCount);
  toolDenied(await call("delete_media", { id: 9100, expectedTitle: "Private foreign music", confirm: true, idempotencyKey: "readonly-delete-denied" }, readable));
});

test("real music creation, retrieval, and duration patch preserve unrelated fields in D1", async () => {
  const created = successful(await call("create_media", {
    type: "music", title: "Fixture song", musicArtist: "Artist A / Artist B", musicAlbum: "Fixture album",
    note: "Private listening note", score: 9, tags: ["FLAC", "J-Pop"],
    metadata: { duration: "03:59", overview: "Original overview" }, idempotencyKey: "music-create",
  }));
  assert.equal(created.ok, true);
  assert.equal(created.verified, true);
  const id = created.media.id;
  const read = successful(await call("get_media", { id })).media;
  assert.equal(read.metadata.duration, "03:59");
  const patched = successful(await call("update_media", { id, metadata: { duration: "04:01" }, idempotencyKey: "music-duration-patch" })).media;
  for (const key of ["title", "musicArtist", "musicAlbum", "note", "score"]) assert.equal(patched[key], read[key], key);
  assert.deepEqual(patched.tags, read.tags);
  assert.equal(patched.metadata.overview, "Original overview");
  assert.equal(patched.metadata.duration, "04:01");
  const [stored] = await query("SELECT user_key,type,title,music_artist,music_album,metadata FROM user_subjects WHERE id=?", [id]);
  assert.equal(stored.user_key, "mcp-test-owner");
  assert.equal(stored.type, "music");
  assert.equal(stored.music_artist, read.musicArtist);
  assert.equal(stored.music_album, read.musicAlbum);
  assert.equal(JSON.parse(stored.metadata).duration, "04:01");
  const [audit] = await query("SELECT agent,status_code FROM agent_operations WHERE resource='media' AND action='update' AND resource_id=?", [id]);
  assert.equal(audit.agent, "chatgpt");
  assert.equal(audit.status_code, 200);
});

test("stable write keys replay the same content operation without duplicate rows", async () => {
  const args = { type: "music", title: "Replay song", idempotencyKey: "music-replay-create" };
  const first = successful(await call("create_media", args));
  const second = successful(await call("create_media", args));
  assert.equal(second.media.id, first.media.id);
  assert.equal(second.replayed, true);
  assert.equal((await query("SELECT COUNT(*) AS count FROM user_subjects WHERE title='Replay song'"))[0].count, 1);
  assert.equal((await query("SELECT COUNT(*) AS count FROM agent_operations WHERE agent='chatgpt' AND idempotency_key LIKE '%:music-replay-create'"))[0].count, 1);
});

test("content schemas reject media-type aliases, images, arbitrary URLs, code, and unknown fields", async () => {
  const beforeCount = (await query("SELECT COUNT(*) AS count FROM user_subjects"))[0].count;
  const invalid = [
    { type: "not-a-media-type" }, { mediaType: "music" }, { images: ["https://evil.invalid/image"] },
    { url: "https://evil.invalid/arbitrary" }, { endpoint: "/api/state" }, { code: "DROP TABLE user_subjects" },
    { metadata: { duration: "03:59", token: "credential" } }, { metadata: { duration: "not-duration" } },
  ];
  for (const [index, patch] of invalid.entries()) {
    toolDenied(await call("create_media", { type: "music", title: "Schema denial", idempotencyKey: `invalid-media-${index}`, ...patch }));
  }
  assert.equal((await query("SELECT COUNT(*) AS count FROM user_subjects"))[0].count, beforeCount);
  assert.equal((await query("SELECT COUNT(*) AS count FROM user_subject_images"))[0].count, 0);
});

test("content reads and updates respect owner boundaries", async () => {
  const search = successful(await call("search_media", {}));
  assert.ok(!search.subjects.some((item) => item.id === 9100));
  toolDenied(await call("get_media", { id: 9100 }));
  toolDenied(await call("update_media", { id: 9100, title: "Foreign overwrite", idempotencyKey: "foreign-media-edit" }));
  toolDenied(await call("get_device", { id: 9100 }));
  toolDenied(await call("update_device", { id: 9100, name: "Foreign overwrite", idempotencyKey: "foreign-device-edit" }));
  assert.equal((await query("SELECT title FROM user_subjects WHERE id=9100"))[0].title, "Private foreign music");
  assert.equal((await query("SELECT name FROM user_devices WHERE id=9100"))[0].name, "Private foreign device");
});

test("device partial updates preserve price, tags, category, review, and cover configuration", async () => {
  const initial = successful(await call("create_device", {
    name: "Fixture headphones", category: "audio", subCategory: "headphones", status: "backup", price: 1250.5,
    purchaseDate: "2026-10-13", rating: 8, tags: ["wired", "desk"], review: "Keep this review",
    coverPositionX: 30, coverPositionY: 70, coverZoom: 125, idempotencyKey: "device-create",
  })).device;
  const updated = successful(await call("update_device", { id: initial.id, name: "Renamed headphones", idempotencyKey: "device-name-patch" })).device;
  assert.equal(updated.name, "Renamed headphones");
  for (const key of ["category", "subCategory", "status", "price", "purchaseDate", "rating", "review", "coverPositionX", "coverPositionY", "coverZoom"]) assert.equal(updated[key], initial[key], key);
  assert.deepEqual(updated.tags, initial.tags);
  const reread = successful(await call("get_device", { id: initial.id })).device;
  assert.equal(reread.price, initial.price);
  assert.equal(reread.review, initial.review);
  assert.deepEqual(reread.tags, initial.tags);
});

test("editing a legacy device preserves tags longer than the connector's new-input limit", async () => {
  const device = successful(await call("create_device", { name: "Legacy headphones", idempotencyKey: "legacy-device-create" })).device;
  const legacyTag = "L".repeat(100);
  await sql([`UPDATE user_devices SET tags='${JSON.stringify([legacyTag])}' WHERE id=${device.id}`]);
  successful(await call("update_device", { id: device.id, name: "Renamed legacy headphones", idempotencyKey: "legacy-device-rename" }));
  const [stored] = await query("SELECT name,tags FROM user_devices WHERE id=?", [device.id]);
  assert.equal(stored.name, "Renamed legacy headphones");
  assert.deepEqual(JSON.parse(stored.tags), [legacyTag], "an unrelated edit does not truncate valid historical content");
});

test("a complete 60-image gallery remains readable when MCP duplicates structured data as text", async () => {
  const id = 9200;
  const thumbnailPrefix = "https://images.invalid/";
  const sourcePrefix = "https://sources.invalid/";
  await sql([
    `INSERT INTO user_subjects (id,user_key,type,title,updated_at) VALUES (${id},'mcp-test-owner','visual','Large valid gallery',1)`,
    ...Array.from({ length: 60 }, (_, index) => {
      const suffix = String(index).padStart(2, "0");
      const thumbnail = thumbnailPrefix + "i".repeat(350 - thumbnailPrefix.length - suffix.length) + suffix;
      const source = sourcePrefix + "s".repeat(700 - sourcePrefix.length - suffix.length) + suffix;
      return `INSERT INTO user_subject_images (user_key,subject_id,thumbnail,source_url,sort_order,is_cover,width,height,mime,created_at,updated_at) VALUES ('mcp-test-owner',${id},'${thumbnail}','${source}',${index},${index === 0 ? 1 : 0},1600,1200,'image/webp',1,1)`;
    }),
  ]);
  const result = await rpc("tools/call", { name: "get_media", arguments: { id } });
  assert.equal(result.response.status, 200);
  const data = successful(result.body);
  assert.equal(data.media.images.length, 60);
  assert.equal(data.media.images[59].sourceUrl.length, 700);
  assert.ok(Buffer.byteLength(JSON.stringify(result.body)) > 160 * 1024, "fixture exercises the original transport response limit");
  assert.deepEqual(JSON.parse(result.body.result.content[0].text), data, "both MCP representations contain the complete gallery");
});

test("OAuth bearer and spoofed ChatGPT headers cannot authenticate directly to Agent routes", async () => {
  const headers = {
    authorization: `Bearer ${writable.access_token}`, cookie: adminCookie,
    "x-agent-token": "chatgpt", "x-agent-name": "chatgpt", "x-chatgpt-user": "mcp-test-owner",
    "x-yuexiaji-content": "chatgpt", "content-type": "application/json", "idempotency-key": "spoofed-direct-write",
  };
  for (const path of ["/api/agent/media", "/api/agent/devices"]) {
    assert.equal((await fetchLocal(path, { headers })).status, 401);
    assert.equal((await fetchLocal(path, { method: "POST", headers, body: JSON.stringify({ title: "Spoofed", name: "Spoofed" }) })).status, 401);
  }
});

test("refresh tokens require the original client and resource and rotate on use", async () => {
  const readOnlyOffline = await connection("content:read offline_access");
  assert.equal((await refresh(readOnlyOffline, { scope: FULL_SCOPE })).status, 400, "refresh cannot expand read-only authorization");
  assert.equal((await refresh(readOnlyOffline)).status, 200, "failed escalation does not consume the legitimate refresh token");
  const credentials = await connection();
  assert.ok(typeof credentials.refresh_token === "string", "offline access grants a refresh token");
  assert.equal((await refresh(credentials, { client_id: await register() })).status, 400);
  assert.equal((await refresh(credentials, { resource: `${origin}/different` })).status, 400);
  const response = await refresh(credentials);
  assert.equal(response.status, 200);
  const next = await response.json();
  assert.ok(next.access_token !== credentials.access_token, "refresh rotates access token");
  assert.ok(next.refresh_token !== credentials.refresh_token, "refresh rotates refresh token");
  assert.equal((await rpc("ping", {}, next)).response.status, 200);
  const replay = await refresh(credentials);
  assert.equal(replay.status, 400, "used refresh token cannot be replayed");
  assert.equal((await replay.json()).error, "invalid_grant");
  assert.equal((await rpc("ping", {}, next)).response.status, 401, "refresh-token replay revokes descendants");
});

test("D1 stores only hashes of codes and access and refresh tokens", async () => {
  const flow = await issueCode();
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const [code] = await query("SELECT * FROM mcp_oauth_codes WHERE code_hash=?", [hash(flow.code)]);
  assert.ok(code && /^[a-f0-9]{64}$/.test(code.code_hash), "the actual code is stored as a hash");
  assert.ok(!JSON.stringify(code).includes(flow.code), "code row contains no plaintext credential");
  const response = await exchange(flow);
  assert.equal(response.status, 200);
  const credentials = await response.json();
  const tokens = await query("SELECT * FROM mcp_oauth_tokens WHERE grant_id=?", [code.grant_id]);
  assert.equal(tokens.length, 2);
  for (const token of tokens) {
    assert.ok(/^[a-f0-9]{64}$/.test(token.token_hash), "credentials are hashed in the real token table");
    assert.ok(!JSON.stringify(token).includes(credentials.access_token), "access token is not stored in plaintext");
    assert.ok(!JSON.stringify(token).includes(credentials.refresh_token), "refresh token is not stored in plaintext");
    assert.equal(token.resource, resource);
    assert.equal(token.client_id, flow.clientId);
  }
  assert.ok(tokens.some((row) => row.token_type === "access" && row.token_hash === hash(credentials.access_token)));
  assert.ok(tokens.some((row) => row.token_type === "refresh" && row.token_hash === hash(credentials.refresh_token)));
});

test("saved storage links are verified, partial edits preserve data, and credentials are rejected", async () => {
  const media = successful(await call("create_media", { type: "music", title: "Storage fixture", idempotencyKey: "storage-media-create" })).media;
  const args = { mediaId: media.id, provider: "mega", path: "/Fixture/music", note: "Archive note", idempotencyKey: "storage-link-create" };
  const first = successful(await call("add_storage_link", args));
  assert.equal(first.verified, true);
  const edited = successful(await call("update_storage_link", { mediaId: media.id, id: first.storageLink.id, label: "Renamed archive", idempotencyKey: "storage-link-edit" }));
  assert.equal(edited.storageLink.path, "/Fixture/music");
  assert.equal(edited.storageLink.provider, "mega");
  assert.equal(edited.storageLink.note, "Archive note");
  const listed = successful(await call("list_storage_links", { mediaId: media.id }));
  assert.equal(listed.storageLinks.length, 1);
  assert.equal(listed.storageLinks[0].label, "Renamed archive");
  for (const [index, invalid] of [{ token: "forbidden" }, { url: "https://user:password@storage.invalid/share" }, { url: "file:///etc/passwd" }].entries()) {
    toolDenied(await call("add_storage_link", { mediaId: media.id, provider: "test", idempotencyKey: `storage-denied-${index}`, ...invalid }));
  }
  toolDenied(await call("list_storage_links", { mediaId: 9100 }));
  assert.equal((await query("SELECT COUNT(*) AS count FROM media_storage_links WHERE media_id=?", [media.id]))[0].count, 1);
  const tags = successful(await call("list_tags", { q: "FLAC" }));
  assert.ok(tags.tags.some((tag) => tag.tag === "FLAC" && tag.count >= 1));
});


test("delete permission is separate: existing edit grants cannot delete or escalate via refresh", async () => {
  const row = successful(await call("create_media", { type: "music", title: "Permission-protected song", idempotencyKey: "delete-permission-fixture" })).media;
  toolDenied(await call("delete_media", { id: row.id, expectedTitle: row.title, confirm: true, idempotencyKey: "delete-denied" }, writable));
  assert.equal((await query("SELECT COUNT(*) AS count FROM user_subjects WHERE id=?", [row.id]))[0].count, 1);
  assert.equal((await refresh(writable, { scope: "content:read content:write content:delete offline_access" })).status, 400);
  const info = successful(await call("connection_info", {}, deletable));
  assert.equal(info.capabilities.deleteContent, true);
  assert.ok(info.scopes.includes("content:delete"));
  assert.equal(successful(await call("connection_info", {}, writable)).capabilities.deleteContent, false);
});

test("delete_media requires confirmation and exact title, preserves owner isolation, and audits replay", async () => {
  const item = successful(await call("create_media", { type: "music", title: "Delete this song", idempotencyKey: "delete-media-fixture" })).media;
  const base = { id: item.id, expectedTitle: item.title, confirm: true, idempotencyKey: "delete-media-perform" };
  toolDenied(await call("delete_media", { ...base, confirm: false }, deletable));
  toolDenied(await call("delete_media", { ...base, expectedTitle: "Other song" }, deletable));
  toolDenied(await call("delete_media", { id: 9100, expectedTitle: "Private foreign music", confirm: true, idempotencyKey: "delete-foreign" }, deletable));
  assert.equal((await query("SELECT COUNT(*) AS count FROM user_subjects WHERE id=?", [item.id]))[0].count, 1);
  const deleted = successful(await call("delete_media", base, deletable));
  assert.equal(deleted.verified, true);
  assert.equal(deleted.deleted.id, item.id);
  assert.equal((await query("SELECT COUNT(*) AS count FROM user_subjects WHERE id=?", [item.id]))[0].count, 0);
  assert.equal(successful(await call("delete_media", base, deletable)).replayed, true);
  assert.equal((await query("SELECT title FROM user_subjects WHERE id=9100"))[0].title, "Private foreign music");
  const [audit] = await query("SELECT agent,status_code FROM agent_operations WHERE resource='media' AND action='delete' AND resource_id=?", [item.id]);
  assert.equal(audit.agent, "chatgpt");
  assert.equal(audit.status_code, 200);
});

test("delete_device only removes a matching owned device", async () => {
  const item = successful(await call("create_device", { name: "Discarded fixture device", idempotencyKey: "delete-device-fixture" })).device;
  const args = { id: item.id, expectedName: item.name, confirm: true, idempotencyKey: "delete-device-perform" };
  toolDenied(await call("delete_device", { ...args, expectedName: "Another device" }, deletable));
  const gone = successful(await call("delete_device", args, deletable));
  assert.equal(gone.deleted.id, item.id);
  assert.equal(gone.verified, true);
  assert.equal(successful(await call("delete_device", args, deletable)).replayed, true);
  assert.equal((await query("SELECT COUNT(*) AS count FROM user_devices WHERE id=?", [item.id]))[0].count, 0);
});

test("delete_storage_link only removes the exact stored reference, not the parent media", async () => {
  const media = successful(await call("create_media", { type: "music", title: "Keep media", idempotencyKey: "delete-link-media" })).media;
  const link = successful(await call("add_storage_link", { mediaId: media.id, provider: "mega", path: "/Temp/file", idempotencyKey: "delete-link-create" })).storageLink;
  const args = { mediaId: media.id, id: link.id, expectedProvider: "mega", confirm: true, idempotencyKey: "delete-link-perform" };
  toolDenied(await call("delete_storage_link", { ...args, expectedProvider: "other" }, deletable));
  const deleted = successful(await call("delete_storage_link", args, deletable));
  assert.equal(deleted.verified, true);
  assert.equal(deleted.deleted.id, link.id);
  assert.equal(successful(await call("delete_storage_link", args, deletable)).replayed, true);
  assert.equal((await query("SELECT COUNT(*) AS count FROM media_storage_links WHERE id=?", [link.id]))[0].count, 0);
  assert.equal((await query("SELECT COUNT(*) AS count FROM user_subjects WHERE id=?", [media.id]))[0].count, 1);
});

test("token revocation immediately disables the entire authorization and browser management can revoke it", async () => {
  const credentials = await connection();
  const revoke = await fetchLocal("/api/mcp/oauth/revoke", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: credentials.clientId, token: credentials.refresh_token, resource }).toString(),
  });
  assert.equal(revoke.status, 200);
  assert.equal((await rpc("ping", {}, credentials)).response.status, 401);
  assert.equal((await refresh(credentials)).status, 400);

  const browserManaged = await connection();
  const [grant] = await query("SELECT id FROM mcp_oauth_grants WHERE client_id=?", [browserManaged.clientId]);
  const page = await consentPage("/connect/chatgpt/manage");
  assert.equal(page.response.status, 200);
  assert.ok(page.csrf, "management page requires CSRF");
  assert.ok(!page.html.includes(browserManaged.access_token) && !page.html.includes(browserManaged.refresh_token), "management displays no bearer credentials");
  const managedRevoke = await fetchLocal("/connect/chatgpt/manage", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: adminCookie, origin },
    body: new URLSearchParams({ csrf_token: page.csrf, grant_id: grant.id, action: "revoke" }).toString(),
  });
  assert.equal(managedRevoke.status, 302);
  assert.equal((await rpc("ping", {}, browserManaged)).response.status, 401);
  assert.equal((await refresh(browserManaged)).status, 400);
});

test("expired OAuth tokens cannot fall back to a valid browser session", async () => {
  const credentials = await connection();
  const tokenHash = createHash("sha256").update(credentials.access_token).digest("hex");
  await sql([`UPDATE mcp_oauth_tokens SET expires_at=1 WHERE token_hash='${tokenHash}'`]);
  assert.equal((await rpc("ping", {}, credentials, { cookie: adminCookie })).response.status, 401);
});

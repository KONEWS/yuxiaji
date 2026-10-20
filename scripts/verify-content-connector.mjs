import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

// Run after deployment using the same scoped Cloudflare credentials. This
// checks schema and public protocol boundaries without granting OAuth access
// or reading/writing the owner's collection.
const base = new URL(process.env.YUEXIAJI_BASE_URL || "https://yuexia.luo66ccff.cc.cd").origin;
const requiredColumns = {
  mcp_oauth_clients: ["client_id", "client_name", "redirect_uris_json", "created_at"],
  mcp_oauth_grants: ["id", "user_key", "client_id", "resource", "scopes_json", "created_at", "last_used_at", "revoked_at"],
  mcp_oauth_codes: ["code_hash", "grant_id", "client_id", "redirect_uri", "resource", "code_challenge", "scopes_json", "expires_at", "consumed_at"],
  mcp_oauth_tokens: ["token_hash", "grant_id", "client_id", "resource", "token_type", "scopes_json", "created_at", "expires_at", "used_at"],
};
const sql = Object.keys(requiredColumns).map((table) => `SELECT '${table}' AS table_name, name FROM pragma_table_info('${table}')`).join(" UNION ALL ");
const { stdout } = await promisify(execFile)(process.execPath, [resolve("node_modules/wrangler/bin/wrangler.js"),
  "d1", "execute", "yuexiaji-db", "--remote", "--config", "wrangler.jsonc", "--command", sql, "--json"],
{ maxBuffer: 1024 * 1024, timeout: 60000 });
const queries = JSON.parse(stdout);
assert.ok(Array.isArray(queries) && queries.every((query) => query.success), "Remote D1 schema query succeeds");
const rows = queries.flatMap((query) => query.results || []);
for (const [table, names] of Object.entries(requiredColumns)) {
  const actual = new Set(rows.filter((row) => row.table_name === table).map((row) => row.name));
  for (const name of names) assert.ok(actual.has(name), `${table}.${name} exists in the production database`);
}
console.log("Verified production columns in all four OAuth tables");

async function verify(path, init, check) {
  let failure;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch(base + path, {
        redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(15000),
        ...init,
      });
      await check(response);
      return;
    } catch (error) { failure = error; }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw failure;
}

await verify("/.well-known/oauth-protected-resource/mcp", {}, async (response) => {
  assert.equal(response.status, 200, "Production MCP protected-resource metadata is public");
  const data = await response.json();
  assert.equal(data.resource, base + "/mcp");
  assert.deepEqual(data.authorization_servers, [base]);
  assert.deepEqual(data.scopes_supported, ["content:read", "content:write", "content:delete", "offline_access"]);
});
await verify("/.well-known/oauth-authorization-server", {}, async (response) => {
  assert.equal(response.status, 200, "Production OAuth discovery succeeds");
  const data = await response.json();
  assert.equal(data.issuer, base);
  assert.equal(data.authorization_endpoint, base + "/connect/chatgpt");
  assert.equal(data.token_endpoint, base + "/api/mcp/oauth/token");
  assert.equal(data.registration_endpoint, base + "/api/mcp/oauth/register");
  assert.deepEqual(data.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(data.scopes_supported, ["content:read", "content:write", "content:delete", "offline_access"]);
  assert.equal(data.authorization_response_iss_parameter_supported, true);
});
await verify("/mcp", {
  method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
}, async (response) => {
  assert.equal(response.status, 401, "Anonymous requests cannot read MCP tools/content");
  assert.ok(response.headers.get("www-authenticate")?.includes(base + "/.well-known/oauth-protected-resource/mcp"));
});
await verify("/connect/chatgpt/manage", {}, async (response) => {
  assert.equal(response.status, 302, "OAuth connection management requires the administrator login");
  const location = new URL(response.headers.get("location"), base);
  assert.equal(location.origin, base);
  assert.equal(location.pathname, "/login");
  assert.equal(location.searchParams.get("next"), "/connect/chatgpt/manage");
});
console.log("Verified live MCP/OAuth discovery, anonymous denial and management login boundary");

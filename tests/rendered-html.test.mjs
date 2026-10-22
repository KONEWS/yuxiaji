import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { unstable_dev } from "wrangler";

let worker;

function fetchLocal(path, init = {}) {
  // Use the real HTTP origin. unstable_dev.fetch rewrites it to a placeholder
  // and can stall on a redirect after a POST is rejected before reading its body.
  const url = new URL(path, `http://${worker.address}:${worker.port}`);
  // Do not reuse a connection after an early authorization rejection, whose
  // request body may not have been consumed by the local Worker proxy.
  return fetch(url, { signal: AbortSignal.timeout(15000), ...init,
    headers: { ...init.headers, connection: "close" },
  });
}

async function uploadRequest(form) {
  // Serialize explicitly so the Worker receives the exact multipart boundary.
  const request = new Request("http://localhost/api/agent/gallery/upload", { method: "POST", body: form });
  return fetchLocal("/api/agent/gallery/upload", {
    method: "POST",
    headers: { "content-type": request.headers.get("content-type") },
    body: await request.arrayBuffer(),
  });
}

before(async () => {
  worker = await unstable_dev("dist/server/index.js", {
    config: "wrangler.jsonc",
    envFiles: ["tests/fixtures/.env.test"],
    local: true,
    persist: false,
    logLevel: "error",
    experimental: {
      disableExperimentalWarning: true,
      disableDevRegistry: true,
      showInteractiveDevSession: false,
      testMode: true,
      watch: false,
    },
  });
});

after(async () => {
  await worker?.stop();
});

test("renders the login page in the Cloudflare Worker runtime", async () => {
  const response = await fetchLocal("/login", {
    headers: { accept: "text/html" },
  });
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  assert.match(html, /<html lang="zh-CN">/i);
  assert.match(html, /<title>月下集<\/title>/i);
  assert.match(html, /href="\/assets\/[^\"]+\.css"/i);
});

test("redirects an unauthenticated home request to login", async () => {
  const response = await fetchLocal("/", {
    headers: { accept: "text/html" },
    redirect: "manual",
  });
  const location = response.headers.get("location");

  assert.equal(response.status, 302);
  assert.ok(location);
  assert.equal(new URL(location).pathname, "/login");
});

test("the compiled production Worker serves MCP discovery before the browser guard", async () => {
  const response = await fetchLocal("/.well-known/oauth-protected-resource/mcp");
  assert.equal(response.status, 200);
  const metadata = await response.json();
  assert.equal(new URL(metadata.resource).pathname, "/mcp");
  assert.deepEqual(metadata.scopes_supported, ["content:read", "content:write", "content:delete", "offline_access"]);

  const authorization = await fetchLocal("/.well-known/oauth-authorization-server");
  assert.equal(authorization.status, 200);
  const issuer = await authorization.json();
  assert.deepEqual(metadata.authorization_servers, [issuer.issuer]);
  assert.equal(new URL(issuer.authorization_endpoint).pathname, "/connect/chatgpt");
});

test("the compiled production Worker keeps MCP separate from browser and Agent routes", async () => {
  const response = await fetchLocal("/mcp", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(response.status, 401);
  assert.ok(response.headers.get("www-authenticate")?.includes("oauth-protected-resource/mcp"));
  assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/i);
  assert.equal((await response.json()).error, "invalid_token");

  const management = await fetchLocal("/connect/chatgpt/manage", { redirect: "manual" });
  assert.equal(management.status, 302);
  const login = new URL(management.headers.get("location"));
  assert.equal(login.pathname, "/login");
  assert.equal(login.searchParams.get("next"), "/connect/chatgpt/manage");
});

test("multipart API uploads larger than 1 MiB reach Agent authentication", async () => {
  const form = new FormData();
  form.set("image", new Blob([new Uint8Array(1200000)], { type: "image/png" }), "large.png");
  form.set("idempotencyKey", "upload-size-auth-probe");
  const response = await uploadRequest(form);

  assert.equal(response.status, 401);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/i);
  assert.ok((await response.json()).error);
});

test("multipart requests above the 21 MiB framework limit are rejected", async () => {
  const form = new FormData();
  form.set("image", new Blob([new Uint8Array(21 * 1024 * 1024 + 1)], { type: "image/png" }), "oversized.png");
  const response = await uploadRequest(form);

  assert.equal(response.status, 413);
});

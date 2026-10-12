import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { unstable_dev } from "wrangler";

let worker;

async function uploadRequest(form) {
  // unstable_dev's fetch proxy doesn't preserve Node FormData boundaries.
  // Serialize it explicitly so the Worker receives a real multipart request.
  const request = new Request("http://localhost/api/agent/gallery/upload", { method: "POST", body: form });
  return worker.fetch("/api/agent/gallery/upload", {
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
  const response = await worker.fetch("/login", {
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
  const response = await worker.fetch("/", {
    headers: { accept: "text/html" },
    redirect: "manual",
  });
  const location = response.headers.get("location");

  assert.equal(response.status, 302);
  assert.ok(location);
  assert.equal(new URL(location).pathname, "/login");
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

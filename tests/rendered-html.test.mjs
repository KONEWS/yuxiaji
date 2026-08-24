import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { unstable_dev } from "wrangler";

let worker;

before(async () => {
  worker = await unstable_dev("dist/server/index.js", {
    config: "wrangler.jsonc",
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

import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error Node's test runner loads TypeScript directly.
import { readLoginStatus, safeLoginNext } from "../app/lib/login-flow.ts";

test("login returns to same-origin paths while rejecting external and browser-normalized targets", () => {
  for (const value of [null, "https://example.com", "//example.com", "/\\example.com", "/\n/example.com", "javascript:alert(1)"]) {
    assert.equal(safeLoginNext(value), "/", String(value));
  }
  assert.equal(safeLoginNext("/connect/chatgpt?client_id=test#confirm"), "/connect/chatgpt?client_id=test#confirm");
  assert.equal(safeLoginNext("/settings/security?force=1"), "/settings/security?force=1");
});

test("login status rejects service failures and malformed payloads instead of offering account initialization", async () => {
  await assert.rejects(readLoginStatus(Response.json({ error: "database unavailable" }, { status: 503 })));
  await assert.rejects(readLoginStatus(Response.json({ error: "unexpected" })));
  await assert.rejects(readLoginStatus(new Response("not JSON")));
  for (const initialized of [true, false]) {
    const status = { initialized, authenticated: false, account: null };
    assert.deepEqual(await readLoginStatus(Response.json(status)), status);
  }
});

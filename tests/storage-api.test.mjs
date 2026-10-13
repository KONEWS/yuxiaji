import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import wrangler from "wrangler";

const { unstable_splitSqlQuery: splitSqlQuery, unstable_dev } = wrangler;

let worker;
const lifecycle = {
  state: "verified", operationKey: "archive-839-v1", objectCount: 23,
  totalBytes: 630269, manifestSha256: "a".repeat(64), verifiedAt: 1790899200123,
};
async function api(path, method = "GET", body, token = "test-nova-token", key) {
  const response = await worker.fetch(path, {
    method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json(), replay: response.headers.get("x-idempotent-replay") };
}
async function sql(statements) {
  const response = await worker.fetch("/__test/sql", { method: "POST", body: JSON.stringify(statements) });
  assert.equal(response.status, 200, await response.text());
}
function checkLifecycle(link) {
  for (const [key, value] of Object.entries(lifecycle)) assert.equal(link[key], value, key);
}

before(async () => {
  worker = await unstable_dev("tests/fixtures/storage-worker.mjs", {
    config: "tests/fixtures/storage-wrangler.jsonc", persist: false, local: true, logLevel: "error",
    experimental: { disableExperimentalWarning: true, disableDevRegistry: true, showInteractiveDevSession: false, testMode: true, watch: false },
  });
  const migrations = (await readdir("drizzle")).filter((name) => name.endsWith(".sql")).sort();
  // Seed an old link before the new migration to verify honest defaults.
  for (const name of migrations) {
    if (name.startsWith("0024_")) {
      await sql([
        "INSERT INTO user_subjects (id,user_key,type,title,updated_at) VALUES (839,'storage-test-owner','visual','legacy',1)",
        "INSERT INTO media_storage_links (user_key,media_id,provider,path,created_at,updated_at) VALUES ('storage-test-owner',839,'mega','/legacy',1,1)",
      ]);
    }
    await sql(splitSqlQuery(await readFile(`drizzle/${name}`, "utf8")));
  }
  await sql([
    ...Array.from({ length: 181 }, (_, index) => `INSERT INTO user_subjects (id,user_key,type,title,updated_at) VALUES (${index + 1},'storage-test-owner','visual','gallery-${index + 1}',1)`),
    "INSERT INTO user_subjects (id,user_key,type,title,updated_at) VALUES (900,'storage-test-owner','video','video',1),(901,'other-owner','visual','private',1)",
    ...Array.from({ length: 181 }, (_, index) => `INSERT INTO user_subject_images (user_key,subject_id,thumbnail,created_at,updated_at) VALUES ('storage-test-owner',${index + 1},'/test/${index + 1}.webp',1,1)`),
  ]);
});
after(async () => { await worker?.stop(); });

test("migration keeps legacy links without inventing verification evidence", async () => {
  const result = await api("/api/agent/storage?mediaId=839");
  assert.equal(result.status, 200);
  const [link] = result.body.storageLinks;
  assert.equal(link.state, "linked");
  assert.equal(link.objectCount, null);
  assert.equal(link.totalBytes, null);
  assert.equal(link.verifiedAt, null);
  assert.equal(link.manifestSha256, "");
});

test("Agent storage POST, GET, media/gallery reads, PATCH and replay preserve lifecycle metadata", async () => {
  const body = { mediaId: 1, provider: "mega", path: "/archive", ...lifecycle, verifiedAt: new Date(lifecycle.verifiedAt).toISOString() };
  const created = await api("/api/agent/storage", "POST", body, undefined, "create-archive");
  assert.equal(created.status, 201);
  const id = created.body.storageLink.id;
  checkLifecycle(created.body.storageLink);
  const replay = await api("/api/agent/storage", "POST", body, undefined, "create-archive");
  assert.equal(replay.replay, "true");
  assert.equal(replay.body.storageLink.id, id);
  for (const path of ["/api/agent/storage?mediaId=1", "/api/media/storage?mediaId=1", "/api/agent/media?id=1", "/api/agent/gallery?id=1"]) {
    const result = await api(path);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const links = result.body.storageLinks ?? result.body.subject?.storageLinks ?? result.body.gallery?.storageLinks;
    assert.equal(links.length, 1);
    checkLifecycle(links[0]);
  }
  const edited = await api("/api/media/storage", "PATCH", { mediaId: 1, id, note: "browser edit" });
  assert.equal(edited.status, 200);
  checkLifecycle(edited.body.storageLink);
  const updatedGallery = await api("/api/agent/gallery", "PATCH", { id: 1, title: "edited gallery" }, undefined, "edit-gallery");
  assert.equal(updatedGallery.status, 200);
  checkLifecycle(updatedGallery.body.gallery.storageLinks[0]);
  const cleared = await api("/api/agent/storage", "PATCH", { mediaId: 1, id, objectCount: null, totalBytes: 0, verifiedAt: null, state: "uncertain" }, undefined, "clear-evidence");
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.storageLink.objectCount, null);
  assert.equal(cleared.body.storageLink.totalBytes, 0);
  assert.equal(cleared.body.storageLink.verifiedAt, null);
});

test("Codex writes are replayable and isolated from Nova operations with the same key", async () => {
  const key = "codex-independent-create";
  const novaBody = { mediaId: 3, provider: "test", path: "/nova" };
  const codexBody = { mediaId: 3, provider: "test", path: "/codex" };
  const nova = await api("/api/agent/storage", "POST", novaBody, "test-nova-token", key);
  const codex = await api("/api/agent/storage", "POST", codexBody, "test-codex-token", key);
  assert.equal(nova.status, 201);
  assert.equal(codex.status, 201);
  assert.equal(codex.body.agent, "codex");
  assert.notEqual(nova.body.storageLink.id, codex.body.storageLink.id);
  assert.equal(codex.body.storageLink.path, "/codex");
  const replay = await api("/api/agent/storage", "POST", codexBody, "test-codex-token", key);
  assert.equal(replay.replay, "true");
  assert.equal(replay.body.storageLink.id, codex.body.storageLink.id);
  const denied = await api(`/api/agent/storage?mediaId=3&id=${codex.body.storageLink.id}`, "DELETE", undefined, "test-codex-token", "codex-delete-denied");
  assert.equal(denied.status, 403);
  const read = await api("/api/agent/storage?mediaId=3", "GET", undefined, "test-codex-token");
  assert.ok(read.body.storageLinks.some((link) => link.id === codex.body.storageLink.id));
});

test("gallery lists beyond 100 entries include images and storage without D1 bind errors", async () => {
  const result = await api("/api/agent/gallery");
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.galleries.length, 182);
  assert.equal(result.body.galleries.filter((item) => item.images.length === 1).length, 181);
  assert.equal(result.body.galleries.find((item) => item.id === 1).storageLinks.length, 1);
  assert.ok(!result.body.galleries.some((item) => item.id === 901));
});

test("video reads and writes include storage associations", async () => {
  const created = await api("/api/agent/storage", "POST", { mediaId: 900, provider: "mega", path: "/video", ...lifecycle }, undefined, "video-archive");
  assert.equal(created.status, 201);
  for (const path of ["/api/agent/video?id=900", "/api/agent/video"]) {
    const result = await api(path);
    assert.equal(result.status, 200);
    checkLifecycle((result.body.video ?? result.body.videos[0]).storageLinks[0]);
  }
  const updated = await api("/api/agent/video", "PATCH", { id: 900, title: "edited video" }, undefined, "edit-video");
  assert.equal(updated.status, 200);
  checkLifecycle(updated.body.video.storageLinks[0]);
});

test("storage rejects invalid metadata, unowned media and Hikari deletion", async () => {
  const malformed = await api("/api/agent/storage", "POST", { mediaId: 2, provider: "mega", path: "/bad", objectCount: -1 }, undefined, "bad-metadata");
  assert.equal(malformed.status, 400);
  assert.equal((await api("/api/agent/storage?mediaId=2")).body.storageLinks.length, 0);
  assert.equal((await api("/api/agent/storage?mediaId=901")).status, 404);
  assert.equal((await api("/api/agent/storage?mediaId=1", "GET", undefined, "invalid")).status, 401);
  const denied = await api("/api/agent/storage?mediaId=1&id=1", "DELETE", undefined, "test-hikari-token", "denied-delete");
  assert.equal(denied.status, 403);
});

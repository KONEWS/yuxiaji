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
  const path = `/api/agent/storage?mediaId=3&id=${codex.body.storageLink.id}`;
  const deleted = await api(path, "DELETE", undefined, "test-codex-token", "codex-delete");
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.agent, "codex");
  assert.equal(deleted.body.deleted.id, codex.body.storageLink.id);
  const deleteReplay = await api(path, "DELETE", undefined, "test-codex-token", "codex-delete");
  assert.equal(deleteReplay.replay, "true");
  assert.deepEqual(deleteReplay.body, deleted.body);
  const read = await api("/api/agent/storage?mediaId=3", "GET", undefined, "test-codex-token");
  assert.ok(!read.body.storageLinks.some((link) => link.id === codex.body.storageLink.id));
  assert.ok(read.body.storageLinks.some((link) => link.id === nova.body.storageLink.id));
});

test("Codex manages owned devices and tags without granting Hikari access", async () => {
  await sql(["INSERT INTO user_devices (id,user_key,name,category,updated_at) VALUES (901,'other-owner','private','audio',1)"]);
  const codex = "test-codex-token";
  const hikari = "test-hikari-token";
  const created = await api("/api/agent/devices", "POST", { name: "Codex test device" }, codex, "codex-device-create");
  assert.equal(created.status, 201);
  assert.equal(created.body.agent, "codex");
  const id = created.body.device.id;
  const read = await api(`/api/agent/devices?id=${id}`, "GET", undefined, codex);
  assert.equal(read.status, 200);
  assert.equal(read.body.device.name, "Codex test device");
  const updated = await api("/api/agent/devices", "PATCH", { id, name: "Edited device" }, codex, "codex-device-update");
  assert.equal(updated.status, 200);
  assert.equal(updated.body.device.name, "Edited device");
  for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
    const denied = await api(`/api/agent/devices?id=${id}`, method, method === "POST" || method === "PATCH" ? { id, name: "Denied" } : undefined, hikari, `hikari-device-${method}`);
    assert.equal(denied.status, 403, method);
  }
  assert.equal((await api("/api/agent/devices?id=901", "GET", undefined, codex)).body.device, null);
  assert.equal((await api("/api/agent/devices?id=901", "DELETE", undefined, codex, "codex-unowned-device")).status, 404);
  const deleted = await api(`/api/agent/devices?id=${id}`, "DELETE", undefined, codex, "codex-device-delete");
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.deleted.id, id);
  assert.deepEqual((await api("/api/agent/devices", "GET", undefined, codex)).body.devices, []);

  const tagged = await api("/api/agent/tags", "POST", { id: 4, tags: ["codex-management"] }, codex, "codex-tags-replace");
  assert.equal(tagged.status, 200);
  assert.equal(tagged.body.agent, "codex");
  assert.deepEqual(tagged.body.tags, ["codex-management"]);
  const tagList = await api("/api/agent/tags", "GET", undefined, hikari);
  assert.equal(tagList.status, 200);
  assert.ok(tagList.body.tags.some(({ tag }) => tag === "codex-management"));
  assert.equal((await api("/api/agent/tags", "POST", { id: 4, tags: [] }, hikari, "hikari-tags-replace")).status, 403);
  assert.equal((await api("/api/agent/tags?tag=codex-management", "DELETE", undefined, hikari, "hikari-tags-remove")).status, 403);
  assert.equal((await api("/api/agent/tags", "POST", { id: 901, tags: ["denied"] }, codex, "codex-unowned-tags")).status, 404);
  const removed = await api("/api/agent/tags?tag=codex-management", "DELETE", undefined, codex, "codex-tags-remove");
  assert.equal(removed.status, 200);
  assert.equal(removed.body.changed, 1);
  assert.deepEqual((await api("/api/agent/media?id=4", "GET", undefined, codex)).body.subject.tags, []);
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


test("request fingerprints reject changed content, resource and delete query without repeating writes", async () => {
  const body = { mediaId: 5, provider: "test", path: "/fingerprint" };
  const created = await api("/api/agent/storage", "POST", body, undefined, "fingerprint");
  assert.equal(created.status, 201);
  const reordered = await api("/api/agent/storage", "POST", { path: body.path, provider: body.provider, mediaId: 5 }, undefined, "fingerprint");
  assert.equal(reordered.replay, "true");
  for (const changed of [{ ...body, path: "/changed" }, { ...body, mediaId: 6 }]) {
    const result = await api("/api/agent/storage", "POST", changed, undefined, "fingerprint");
    assert.equal(result.status, 409);
    assert.equal(result.body.code, "idempotency_conflict");
  }
  assert.equal((await api("/api/agent/devices", "POST", { name: "conflict" }, undefined, "fingerprint")).status, 409);
  assert.equal((await api("/api/agent/storage?mediaId=5")).body.storageLinks.length, 1);
  const removed = await api("/api/agent/tags?tag=absent-a", "DELETE", undefined, undefined, "query-key");
  assert.equal(removed.status, 200);
  assert.equal((await api("/api/agent/tags?tag=absent-b", "DELETE", undefined, undefined, "query-key")).body.code, "idempotency_conflict");
  assert.equal((await api("/api/agent/storage", "POST", body, undefined, "x".repeat(161))).status, 400);
});

test("pending operations become uncertain, remain isolated, and are never automatically re-executed", async () => {
  const reserved = await api("/__test/reserve", "POST", { value: 1 }, undefined, "stale-operation");
  assert.equal(reserved.body.kind, "reserved");
  assert.equal((await api("/__test/reserve", "POST", { value: 2 }, undefined, "stale-operation")).body.code, "idempotency_conflict");
  assert.equal((await api("/__test/reserve", "POST", { value: 1 }, undefined, "stale-operation")).body.code, "operation_pending");
  await sql([`UPDATE agent_operations SET started_at=1 WHERE id=${reserved.body.id}`]);
  const stale = await api("/__test/reserve", "POST", { value: 1 }, undefined, "stale-operation");
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "operation_outcome_unknown");
  assert.equal(stale.body.retryable, false);
  const path = "/api/agent/operations?idempotencyKey=stale-operation";
  const state = await api(path);
  assert.equal(state.body.operation.state, "uncertain");
  assert.equal(state.body.operation.nextAction, "read_resource_before_retry");
  assert.equal((await api(path, "GET", undefined, "test-hikari-token")).status, 404);
  assert.equal((await api(path, "GET", undefined, "invalid")).status, 401);
  assert.ok(!JSON.stringify(state.body).includes("requestHash"));
});

test("confirmed pre-write failures can be claimed only once, then replay success", async () => {
  const key = "safe-recovery";
  const body = { value: "safe" };
  const reserved = await api("/__test/reserve", "POST", body, undefined, key);
  const id = reserved.body.id;
  await sql([`UPDATE agent_operations SET started_at=1 WHERE id=${id}`]);
  await api("/__test/finish", "POST", { id, status: 503, payload: { error: "service unavailable" }, retrySafe: true });
  assert.equal((await api("/api/agent/operations?idempotencyKey=" + key)).body.operation.state, "retryable");
  assert.equal((await api("/__test/reserve", "POST", body, undefined, key)).body.code, "operation_retry_later");
  await sql([`UPDATE agent_operations SET started_at=1 WHERE id=${id}`]);
  const retries = await Promise.all(Array.from({ length: 4 }, () => api("/__test/reserve", "POST", body, undefined, key)));
  assert.equal(retries.filter(r => r.body.kind === "reserved").length, 1);
  assert.equal(retries.find(r => r.body.kind === "reserved").body.id, id);
  await api("/__test/finish", "POST", { id, status: 201, payload: { ok: true, value: "saved" } });
  // A catch after an uncertain audit response must not downgrade a committed success.
  await api("/__test/finish", "POST", { id, status: 500, payload: { error: "late error" } });
  const replay = await api("/__test/reserve", "POST", body, undefined, key);
  assert.equal(replay.replay, "true");
  assert.equal(replay.status, 201);
  assert.equal(replay.body.value, "saved");
});

test("uncertain failures are replayed, oversized receipts stay valid JSON, and legacy rows remain compatible", async () => {
  const body = { value: "uncertain" };
  const reserved = await api("/__test/reserve", "POST", body, undefined, "uncertain-failure");
  await api("/__test/finish", "POST", { id: reserved.body.id, status: 500, payload: { error: "unknown commit outcome" } });
  const failed = await api("/__test/reserve", "POST", body, undefined, "uncertain-failure");
  assert.equal(failed.replay, "true");
  assert.equal(failed.status, 500);
  const large = await api("/__test/reserve", "POST", {}, undefined, "large-receipt");
  await api("/__test/finish", "POST", { id: large.body.id, status: 200, payload: { data: "x".repeat(200001) } });
  const receipt = await api("/__test/reserve", "POST", {}, undefined, "large-receipt");
  assert.equal(receipt.status, 409);
  assert.equal(receipt.body.code, "operation_receipt_too_large");
  assert.equal(receipt.body.retryable, false);
  await sql(["INSERT INTO agent_operations (user_key,agent,idempotency_key,resource,action,status_code,response_json,created_at) VALUES ('storage-test-owner','nova','legacy-replay','fixture','create',200,'{\"ok\":true}',1)"]);
  assert.equal((await api("/__test/reserve", "POST", {}, undefined, "legacy-replay")).replay, "true");
});

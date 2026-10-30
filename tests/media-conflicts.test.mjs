import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import wrangler from "wrangler";

const { unstable_splitSqlQuery: splitSqlQuery, unstable_dev } = wrangler;
const owner = "media-conflicts-owner";
let worker;
let cookie;

async function api(method = "GET", body, path = "/api/media", headers = {}) {
  const response = await worker.fetch(path, {
    method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json(), replayed: response.headers.get("x-idempotent-replay") === "true" };
}

async function sql(statements) {
  const result = await api("POST", statements, "/__test/sql");
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body.results;
}

async function asset(url, create = false) {
  const result = await api(create ? "POST" : "GET", undefined, `/__test/asset?url=${encodeURIComponent(url)}`);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body.exists;
}

async function create(fields = {}) {
  const result = await api("POST", {
    mediaType: "anime", title: "Revision test", total: 12, progress: 3, status: "watching", ...fields,
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(typeof result.body.subject.revision, "string");
  assert.ok(result.body.subject.revision.length >= 32);
  return result.body.subject;
}

async function read(id) {
  const result = await api();
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body.subjects.find((subject) => subject.id === id);
}

function conflict(result) {
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(result.body.code, "media_conflict");
}

before(async () => {
  worker = await unstable_dev("tests/fixtures/media-conflicts-worker.mjs", {
    config: "tests/fixtures/media-conflicts-wrangler.jsonc", envFiles: ["tests/fixtures/.env.test"], persist: false, local: true, logLevel: "error",
    experimental: { disableExperimentalWarning: true, disableDevRegistry: true, showInteractiveDevSession: false, testMode: true, watch: false },
  });
  const migrations = (await readdir("drizzle")).filter((name) => name.endsWith(".sql")).sort();
  for (const name of migrations) await sql(splitSqlQuery(await readFile(`drizzle/${name}`, "utf8")));
  const setup = await worker.fetch("/__test/setup", { method: "POST" });
  assert.equal(setup.status, 200, await setup.text());
cookie = setup.headers.get("set-" + "cookie")?.split(";")[0];
});

test("browser media and device routes reject requests without an admin session", async () => {
  const saved = cookie;
  cookie = undefined;
  try {
    assert.equal((await api("GET")).status, 401);
    assert.equal((await api("POST", { name: "No session" }, "/api/devices")).status, 401);
  } finally {
    cookie = saved;
  }
  const csrf = await worker.fetch("/api/media", {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: "https://evil.invalid" },
    body: JSON.stringify({ title: "Cross site" }),
  });
  assert.equal(csrf.status, 403);
});

async function avatarUpload(bytes, type, withCookie = true) {
  const form = new FormData();
  form.set("avatar", new Blob([bytes], { type }), "avatar.png");
  const request = new Request("http://localhost/api/avatar", { method: "POST", body: form });
  return worker.fetch("/api/avatar", {
    method: "POST",
    headers: { "content-type": request.headers.get("content-type"), ...(withCookie && cookie ? { cookie } : {}) },
    body: await request.arrayBuffer(),
  });
}

test("avatar uploads verify image magic bytes, not only the declared type", async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const accepted = await avatarUpload(png, "image/png");
  assert.equal(accepted.status, 200, await accepted.text());
  const rejected = await avatarUpload(new TextEncoder().encode("<html>not an image</html>"), "image/png");
  assert.equal(rejected.status, 415);
  const anonymous = await avatarUpload(png, "image/png", false);
  assert.equal(anonymous.status, 401);
});

after(async () => { await worker?.stop(); });

test("browser revisions describe the returned content and remain stable until an edit", async () => {
  const created = await create({ title: "Stable revision", globalScore: 8.5 });
  const firstRead = await read(created.id);
  assert.equal(firstRead.revision, created.revision);
  assert.equal((await read(created.id)).revision, created.revision);
  const edited = await api("POST", { id: created.id, expectedRevision: created.revision, note: "new note" });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.subject.note, "new note");
  assert.equal(edited.body.subject.progress, 3);
  assert.notEqual(edited.body.subject.revision, created.revision);
  assert.equal((await read(created.id)).revision, edited.body.subject.revision);
});

test("opening a detail reads only the requested owned record", async () => {
  const created = await create({ title: "Detail read" });
  const result = await api("GET", undefined, `/api/media?id=${created.id}`);
  assert.equal(result.status, 200);
  assert.equal(result.body.subjects.length, 1);
  assert.equal(result.body.subjects[0].id, created.id);
  assert.equal(result.body.subjects[0].revision, created.revision);
  assert.deepEqual((await api("GET", undefined, "/api/media?id=999999999")).body.subjects, []);
  assert.equal((await api("GET", undefined, "/api/media?id=invalid")).status, 400);
});

test("same-timestamp server edits invalidate old browser updates without overwriting them", async () => {
  const original = await create({ title: "Server update", note: "old" });
  await sql([`UPDATE user_subjects SET note='Agent note' WHERE id=${original.id} AND user_key='${owner}'`]);
  const remote = await read(original.id);
  assert.equal(remote.updatedAt, original.updatedAt);
  assert.notEqual(remote.revision, original.revision);
  conflict(await api("POST", { id: original.id, expectedRevision: original.revision, title: "stale title", note: "old" }));
  const after = await read(original.id);
  assert.equal(after.title, "Server update");
  assert.equal(after.note, "Agent note");
  assert.equal(after.revision, remote.revision);
});

test("an Agent image appended in the same millisecond survives stale title, score, and image-list saves", async () => {
  const imageA = "/api/media-assets?v=conflict_image_A_0001";
  const imageB = "/api/media-assets?v=conflict_image_B_0001";
  await asset(imageA, true);
  await asset(imageB, true);
  const original = await create({ mediaType: "visual", title: "Append race", images: [{ thumbnail: imageA, isCover: true }] });
  await sql([`INSERT INTO user_subject_images (user_key,subject_id,thumbnail,sort_order,is_cover,created_at,updated_at) VALUES ('${owner}',${original.id},'${imageB}',1,0,${original.updatedAt},${original.updatedAt})`]);
  const remote = await read(original.id);
  assert.equal(remote.updatedAt, original.updatedAt);
  assert.equal(remote.images.length, 2);
  assert.notEqual(remote.revision, original.revision);
  for (const edit of [{ title: "stale title" }, { score: 9 }, { title: "stale title", images: original.images }]) {
    conflict(await api("POST", { id: original.id, expectedRevision: original.revision, ...edit }));
    assert.equal(await asset(imageB), true);
  }
  const unchanged = await read(original.id);
  assert.equal(unchanged.title, "Append race");
  assert.deepEqual(unchanged.images.map((image) => image.thumbnail), [imageA, imageB]);
  const refreshed = await api("POST", { id: original.id, expectedRevision: unchanged.revision, title: "Fresh title" });
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
  assert.deepEqual(refreshed.body.subject.images.map((image) => image.thumbnail), [imageA, imageB]);
  assert.equal(await asset(imageB), true);
});

test("unversioned legacy image replacement is rejected while legacy partial edits preserve images", async () => {
  const original = await create({ mediaType: "visual", title: "Legacy browser", images: [{ thumbnail: "/test/legacy-A.webp" }, { thumbnail: "/test/legacy-B.webp" }] });
  conflict(await api("POST", { id: original.id, title: "unsafe legacy", images: [original.images[0]] }));
  const edited = await api("POST", { id: original.id, note: "compatible partial edit" });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.subject.title, "Legacy browser");
  assert.equal(edited.body.subject.note, "compatible partial edit");
  assert.equal(edited.body.subject.images.length, 2);
});

test("fresh explicit gallery edits reorder and delete images and clean only the removed asset", async () => {
  const imageA = "/api/media-assets?v=legitimate_image_A_0001";
  const imageB = "/api/media-assets?v=legitimate_image_B_0001";
  await asset(imageA, true);
  await asset(imageB, true);
  const original = await create({ mediaType: "visual", images: [{ thumbnail: imageA, isCover: true }, { thumbnail: imageB }] });
  const reordered = await api("POST", {
    id: original.id, expectedRevision: original.revision,
    images: [...original.images].reverse().map((image, index) => ({ ...image, isCover: index === 0 })),
  });
  assert.equal(reordered.status, 200, JSON.stringify(reordered.body));
  assert.deepEqual(reordered.body.subject.images.map((image) => image.thumbnail), [imageB, imageA]);
  assert.equal(reordered.body.subject.thumbnail, imageB);
  const removed = await api("POST", {
    id: original.id, expectedRevision: reordered.body.subject.revision,
    images: [reordered.body.subject.images[1]],
  });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.deepEqual(removed.body.subject.images.map((image) => image.thumbnail), [imageA]);
  assert.equal(removed.body.subject.thumbnail, imageA);
  assert.equal(await asset(imageA), true);
  assert.equal(await asset(imageB), false);
});

test("concurrent writes with the same revision commit exactly once", async () => {
  const original = await create({ title: "Concurrent writers", note: "baseline" });
  const results = await Promise.all(Array.from({ length: 4 }, (_, index) => api("POST", {
    id: original.id, expectedRevision: original.revision, note: `writer-${index}`,
  })));
  const successful = results.filter((result) => result.status === 200);
  assert.equal(successful.length, 1, JSON.stringify(results));
  for (const result of results.filter((result) => result.status !== 200)) conflict(result);
  const stored = await read(original.id);
  assert.equal(stored.note, successful[0].body.subject.note);
  assert.equal(stored.revision, successful[0].body.subject.revision);
});

test("the transactional guard rejects an image appended after the update snapshot was already read", async () => {
  const original = await create({ mediaType: "visual", title: "Guard boundary", images: [{ thumbnail: "/test/guard-A.webp" }] });
  const result = await api("POST", { id: original.id, imageUrl: "/test/guard-B.webp" }, "/__test/stale-snapshot");
  conflict(result);
  const stored = await read(original.id);
  assert.equal(stored.title, "Guard boundary");
  assert.deepEqual(stored.images.map((image) => image.thumbnail), ["/test/guard-A.webp", "/test/guard-B.webp"]);
  assert.equal(stored.updatedAt, original.updatedAt);
});

test("a full 60-image gallery supports versioned reorder and deletion within D1 parameter limits", async () => {
  const original = await create({ mediaType: "visual", title: "Sixty images", images: Array.from({ length: 60 }, (_, index) => ({ thumbnail: `/test/sixty-${index}.webp` })) });
  assert.equal(original.images.length, 60);
  const reordered = await api("POST", {
    id: original.id, expectedRevision: original.revision,
    images: [...original.images].reverse().map((image, index) => ({ ...image, isCover: index === 0 })),
  });
  assert.equal(reordered.status, 200, JSON.stringify(reordered.body));
  assert.equal(reordered.body.subject.images.length, 60);
  assert.equal(reordered.body.subject.images[0].thumbnail, "/test/sixty-59.webp");
  const reduced = await api("POST", { id: original.id, expectedRevision: reordered.body.subject.revision, images: [reordered.body.subject.images[0]] });
  assert.equal(reduced.status, 200, JSON.stringify(reduced.body));
  assert.equal(reduced.body.subject.images.length, 1);
});

test("revisions do not grant access to another owner's media", async () => {
  await sql(["INSERT INTO user_subjects (id,user_key,type,title,updated_at) VALUES (900001,'another-owner','visual','Private',1)"]);
  assert.equal(await read(900001), undefined);
  const own = await create();
  const result = await api("POST", { id: 900001, expectedRevision: own.revision, title: "Unauthorized" });
  assert.equal(result.status, 404);
  const [row] = await sql(["SELECT title FROM user_subjects WHERE id=900001"]);
  assert.equal(row.results[0].title, "Private");
});

test("Agent gallery writes remain compatible with their independent authorization and idempotency contract", async () => {
  const result = await api("POST", { title: "Agent gallery", images: [{ thumbnail: "/test/agent.webp" }] }, "/api/agent/gallery", {
    authorization: "Bearer media-conflicts-nova", "Idempotency-Key": "agent-gallery-create",
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  const updated = await api("PATCH", { id: result.body.gallery.id, title: "Agent updated" }, "/api/agent/gallery", {
    authorization: "Bearer media-conflicts-nova", "Idempotency-Key": "agent-gallery-update",
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.gallery.title, "Agent updated");
});

test("browser creation retries replay the original receipt without creating another record", async () => {
  const body = { mediaType: "anime", title: "Lost browser response", idempotencyKey: "browser-lost-response", total: 12, progress: 0 };
  const first = await api("POST", body);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const replay = await api("POST", { progress: 0, total: 12, idempotencyKey: body.idempotencyKey, title: body.title, mediaType: "anime" });
  assert.equal(replay.status, 201, JSON.stringify(replay.body));
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.body, first.body);
  const [count] = await sql([`SELECT count(*) AS count FROM user_subjects WHERE user_key='${owner}' AND title='Lost browser response'`]);
  assert.equal(count.results[0].count, 1);

  const changed = await api("POST", { ...body, title: "Changed retry content" });
  assert.equal(changed.status, 409, JSON.stringify(changed.body));
  assert.equal(changed.body.code, "idempotency_conflict");
  assert.equal((await read(first.body.subject.id)).title, body.title);
});

test("concurrent browser creates with one key commit only once", async () => {
  const body = { mediaType: "anime", title: "Concurrent browser create", idempotencyKey: "browser-concurrent-create" };
  const results = await Promise.all(Array.from({ length: 4 }, () => api("POST", body)));
  assert.ok(results.some((result) => result.status === 201), JSON.stringify(results));
  for (const result of results) {
    assert.ok([201, 409].includes(result.status), JSON.stringify(result));
    if (result.status === 409) assert.equal(result.body.code, "operation_pending");
  }
  const [count] = await sql([`SELECT count(*) AS count FROM user_subjects WHERE user_key='${owner}' AND title='Concurrent browser create'`]);
  assert.equal(count.results[0].count, 1);
  const replay = await api("POST", body);
  assert.equal(replay.status, 201, JSON.stringify(replay.body));
  assert.equal(replay.replayed, true);
});

test("replaying a browser create after deletion never recreates the deleted record", async () => {
  const body = { mediaType: "anime", title: "Deleted create receipt", idempotencyKey: "browser-deleted-receipt" };
  const created = await api("POST", body);
  assert.equal(created.status, 201);
  assert.equal((await api("DELETE", undefined, `/api/media?id=${created.body.subject.id}`)).status, 200);
  const replay = await api("POST", body);
  assert.equal(replay.status, 409);
  assert.equal(replay.body.code, "operation_resource_missing");
  assert.equal(replay.replayed, true);
  assert.equal(await read(created.body.subject.id), undefined);
  const [count] = await sql([`SELECT count(*) AS count FROM user_subjects WHERE user_key='${owner}' AND title='Deleted create receipt'`]);
  assert.equal(count.results[0].count, 0);
});

test("browser and Agent idempotency scopes remain independent and caller fields cannot select identity", async () => {
  const key = "shared-browser-agent-key";
  const browser = await api("POST", { mediaType: "visual", title: "Browser identity", idempotencyKey: key, agent: "nova", source: "openclaw" });
  assert.equal(browser.status, 201, JSON.stringify(browser.body));
  const agent = await api("POST", { title: "Agent identity", images: [{ thumbnail: "/test/agent-identity.webp" }] }, "/api/agent/gallery", {
    authorization: "Bearer media-conflicts-nova", "Idempotency-Key": key,
  });
  assert.equal(agent.status, 201, JSON.stringify(agent.body));
  assert.notEqual(browser.body.subject.id, agent.body.gallery.id);
  const [operations] = await sql([`SELECT agent,source FROM agent_operations WHERE user_key='${owner}' AND idempotency_key='${key}' ORDER BY agent`]);
  assert.deepEqual(operations.results, [{ agent: "browser", source: "browser" }, { agent: "nova", source: "openclaw" }]);
});

test("an uncertain receipt write leaves a pending reservation and cannot create another record", async () => {
  const body = { mediaType: "anime", title: "Uncertain browser receipt", idempotencyKey: "browser-uncertain-receipt" };
  await sql([`CREATE TRIGGER fail_browser_receipt BEFORE UPDATE ON agent_operations WHEN NEW.agent='browser' AND NEW.idempotency_key='browser-uncertain-receipt' AND NEW.status_code=201 BEGIN SELECT RAISE(ABORT,'simulated receipt failure'); END`]);
  const failed = await api("POST", body);
  assert.equal(failed.status, 503, JSON.stringify(failed.body));
  assert.equal(failed.body.code, "operation_outcome_unknown");
  await sql(["DROP TRIGGER fail_browser_receipt"]);
  const retried = await api("POST", body);
  assert.equal(retried.status, 409, JSON.stringify(retried.body));
  assert.equal(retried.body.code, "operation_pending");
  const [count, operation] = await sql([
    `SELECT count(*) AS count FROM user_subjects WHERE user_key='${owner}' AND title='Uncertain browser receipt'`,
    `SELECT status_code FROM agent_operations WHERE user_key='${owner}' AND agent='browser' AND idempotency_key='browser-uncertain-receipt'`,
  ]);
  assert.equal(count.results[0].count, 1);
  assert.equal(operation.results[0].status_code, 102);
});


test("removing a gallery preserves its image when a media or device still references it", async () => {
  const urls = ["shared_media_cover_0001", "shared_device_cover_0001", "shared_device_receipt_0001", "shared_movie_backdrop_0001"].map((version) => `/api/media-assets?v=${version}`);
  for (const url of urls) await asset(url, true);
  const gallery = await create({ mediaType: "visual", images: urls.map((thumbnail) => ({ thumbnail })) });
  await create({ mediaType: "music", image: urls[0] });
  await create({ mediaType: "movie", metadata: { backdropImage: urls[3] } });
  const device = await api("POST", { name: "Shared artwork", coverImage: urls[1], receiptImage: urls[2] }, "/api/devices");
  assert.equal(device.status, 200);
  const deleted = await api("DELETE", undefined, `/api/media?id=${gallery.id}`);
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  for (const url of urls) assert.equal(await asset(url), true);
});

test("cleanup batches large asset lists and deletes only assets without current references", async () => {
  const urls = Array.from({ length: 190 }, (_, index) => `/api/media-assets?v=cleanup_batch_image_${String(index).padStart(4, "0")}`);
  await asset(urls[0], true);
  await asset(urls[189], true);
  await create({ mediaType: "music", image: urls[189] });
  const result = await api("POST", urls, "/__test/cleanup");
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(await asset(urls[0]), false);
  assert.equal(await asset(urls[189]), true);
});

test("nested video metadata patches are not overwritten by stored legacy aliases", async () => {
  const video = await create({ mediaType: "video", metadata: { platform: "old", creator: "original", duration: "1:00" } });
  const edited = await api("POST", { id: video.id, expectedRevision: video.revision, metadata: { platform: "new", creator: "updated" } });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.subject.metadata.platform, "new");
  assert.equal(edited.body.subject.metadata.creator, "updated");
  assert.equal(edited.body.subject.metadata.duration, "1:00");
  const alias = await api("POST", { id: video.id, expectedRevision: edited.body.subject.revision, platform: "explicit alias" });
  assert.equal(alias.status, 200);
  assert.equal(alias.body.subject.metadata.platform, "explicit alias");
});

test("device prices distinguish missing values from an explicit zero", async () => {
  for (const price of [null, "", "  ", undefined, 0, "0", 1.25]) {
    const result = await api("POST", { name: "Price semantics", price }, "/api/devices");
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.device.price, price === 0 || price === "0" ? 0 : price === 1.25 ? 1.25 : null);
  }
  const priced = await api("POST", { name: "Clear price", price: 128 }, "/api/devices");
  const cleared = await api("POST", { id: priced.body.device.id, name: "Clear price", price: null }, "/api/devices");
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.device.price, null);
  for (const body of [null, [], "invalid"]) {
    assert.equal((await api("POST", body, "/api/devices")).status, 400);
  }
});

test("device creates replay one committed result, reject changed input, and never resurrect deleted records", async () => {
  const body = { name: "Retry-safe device", price: 128, idempotencyKey: "browser-device-retry" };
  const original = await api("POST", body, "/api/devices");
  assert.equal(original.status, 200, JSON.stringify(original.body));
  const replay = await api("POST", body, "/api/devices");
  assert.equal(replay.status, 200);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.body, original.body);
  const changed = await api("POST", { ...body, price: 256 }, "/api/devices");
  assert.equal(changed.status, 409);
  assert.equal(changed.body.code, "idempotency_conflict");
  const [count] = await sql(["SELECT count(*) AS count FROM user_devices WHERE name='Retry-safe device'"]);
  assert.equal(count.results[0].count, 1);
  assert.equal((await api("DELETE", undefined, `/api/devices?id=${original.body.device.id}`)).status, 200);
  const missing = await api("POST", body, "/api/devices");
  assert.equal(missing.status, 409);
  assert.equal(missing.body.code, "operation_resource_missing");
});

test("concurrent device create retries share one reservation", async () => {
  const body = { name: "Concurrent device", idempotencyKey: "browser-device-concurrent" };
  const results = await Promise.all(Array.from({ length: 4 }, () => api("POST", body, "/api/devices")));
  assert.ok(results.some((result) => result.status === 200), JSON.stringify(results));
  for (const result of results) assert.ok(result.status === 200 || result.status === 409 && result.body.code === "operation_pending", JSON.stringify(result));
  const [count] = await sql(["SELECT count(*) AS count FROM user_devices WHERE name='Concurrent device'"]);
  assert.equal(count.results[0].count, 1);
  const replay = await api("POST", body, "/api/devices");
  assert.equal(replay.status, 200);
  assert.equal(replay.replayed, true);
});


test("a device receipt failure preserves the reservation instead of duplicating the committed device", async () => {
  const body = { name: "Uncertain device receipt", idempotencyKey: "device-uncertain-receipt" };
  await sql(["CREATE TRIGGER fail_device_receipt BEFORE UPDATE ON agent_operations WHEN NEW.agent='browser' AND NEW.idempotency_key='device-uncertain-receipt' AND NEW.status_code=200 BEGIN SELECT RAISE(ABORT,'simulated receipt failure'); END"]);
  const failed = await api("POST", body, "/api/devices");
  assert.equal(failed.status, 503, JSON.stringify(failed.body));
  assert.equal(failed.body.code, "operation_outcome_unknown");
  await sql(["DROP TRIGGER fail_device_receipt"]);
  const retried = await api("POST", body, "/api/devices");
  assert.equal(retried.status, 409, JSON.stringify(retried.body));
  assert.equal(retried.body.code, "operation_pending");
  const [count] = await sql(["SELECT count(*) AS count FROM user_devices WHERE name='Uncertain device receipt'"]);
  assert.equal(count.results[0].count, 1);
});

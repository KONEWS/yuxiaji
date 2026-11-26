import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { deflateSync } from "node:zlib";
import wrangler from "wrangler";
import { backupCrc32, inspectBackupZip, readBackupZipEntry } from "../app/lib/backup-zip.ts";

const { unstable_dev, unstable_splitSqlQuery: splitSqlQuery } = wrangler;
const owner = "backup-archive-owner";
const ownerHash = createHash("sha256").update(owner).digest("hex");
const backupPrefix = `backups-v2/${ownerHash}/`;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
let worker;
let cookie;
let sources;

function png(red, green, blue) {
  const chunk = (type, data) => {
    const name = Buffer.from(type);
    const result = Buffer.alloc(12 + data.length);
    result.writeUInt32BE(data.length, 0);
    name.copy(result, 4);
    data.copy(result, 8);
    result.writeUInt32BE(backupCrc32(Buffer.concat([name, data])), 8 + data.length);
    return result;
  };
  const dimensions = Buffer.alloc(13);
  dimensions.writeUInt32BE(1, 0); dimensions.writeUInt32BE(1, 4);
  dimensions[8] = 8; dimensions[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", dimensions),
    chunk("IDAT", deflateSync(Buffer.from([0, red, green, blue, 255]))), chunk("IEND", Buffer.alloc(0)),
  ]);
}
const images = [png(102, 204, 255), png(139, 140, 216), png(255, 255, 255)];

async function request(path, init = {}) {
  return worker.fetch(path, { ...init, headers: { ...(cookie ? { cookie } : {}), ...init.headers } });
}
async function api(path, body) {
  const response = await request(path, {
    method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}
async function sql(statements) {
  const result = await api("/__test/sql", statements);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body.results;
}
async function putObject(key, bytes, contentType = "image/png") {
  const response = await request(`/__test/object?key=${encodeURIComponent(key)}`, { method: "PUT", body: bytes, headers: { "content-type": contentType } });
  assert.equal(response.status, 200, await response.text());
}
async function deleteObject(key) {
  const response = await request(`/__test/object?key=${encodeURIComponent(key)}`, { method: "DELETE" });
  assert.equal(response.status, 200, await response.text());
}
async function data() {
  const result = await api("/__test/data");
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
}
async function list() {
  const result = await api("/api/backup/archives");
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
}
async function complete(id) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await api("/api/backup/archives", { action: "continue", id });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const backup = result.body.backup;
    assert.notEqual(backup.status, "failed", JSON.stringify(backup));
    if (backup.status === "complete") return backup;
  }
  assert.fail("backup did not finish within its bounded continuation requests");
}
async function createComplete() {
  const created = await api("/api/backup/archives", { action: "create" });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  return complete(created.body.backup.id);
}
async function download(id) {
  const response = await request(`/api/backup/archive?id=${encodeURIComponent(id)}`);
  assert.equal(response.status, 200, response.headers.get("content-type"));
  assert.match(response.headers.get("content-type"), /application\/zip/);
  const file = await response.blob();
  // Workerd may switch a streamed response to chunked transfer and omit the
  // length header. Validate it when supplied, then independently inspect ZIP.
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) assert.equal(file.size, Number(declaredLength));
  const entries = await inspectBackupZip(file);
  const parts = new Map();
  for (const entry of entries) parts.set(entry.name, await readBackupZipEntry(file, entry));
  const manifest = JSON.parse(await parts.get("backup.json").text());
  for (const asset of manifest.assets) {
    const blob = parts.get(`assets/${asset.sha256}`);
    assert.ok(blob, asset.sha256);
    assert.equal(blob.size, asset.size);
    assert.equal(sha256(Buffer.from(await blob.arrayBuffer())), asset.sha256);
  }
  return { file, entries, parts, manifest };
}
async function restore(id) {
  const preview = await api("/api/backup/archive", { action: "preview", id });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const parameters = { action: "restore", id, expectedFingerprint: preview.body.expectedFingerprint, confirmed: true };
  const initial = await api("/api/backup/archive", parameters);
  assert.equal(initial.status, 202, JSON.stringify(initial.body));
  assert.equal(initial.body.needsPreparation, true);
  await complete(initial.body.preRestoreBackupId);
  parameters.preRestoreBackupId = initial.body.preRestoreBackupId;
  let continuations = 0;
  for (let attempt = 0; attempt < 20; attempt++) {
    const result = await api("/api/backup/archive", parameters);
    assert.ok([200, 202].includes(result.status), JSON.stringify(result.body));
    if (result.status === 200) return { ...result.body, parameters, continuations };
    assert.equal(result.body.needsMore, true);
    continuations++;
  }
  assert.fail("restore did not finish within its bounded continuation requests");
}

before(async () => {
  worker = await unstable_dev("tests/fixtures/backup-archive-worker.mjs", {
    config: "tests/fixtures/backup-archive-wrangler.jsonc", envFiles: ["tests/fixtures/.env.test"],
    persist: false, local: true, logLevel: "error",
    experimental: { disableExperimentalWarning: true, disableDevRegistry: true, showInteractiveDevSession: false, testMode: true, watch: false },
  });
  for (const name of (await readdir("drizzle")).filter((name) => name.endsWith(".sql")).sort()) {
    await sql(splitSqlQuery(await readFile(`drizzle/${name}`, "utf8")));
  }
  const setup = await worker.fetch("/__test/setup", { method: "POST" });
  assert.equal(setup.status, 200, await setup.text());
  cookie = setup.headers.get("set-cookie")?.split(";")[0];
});
after(async () => { await worker?.stop(); });

beforeEach(async () => {
  await request("/__test/objects", { method: "DELETE" });
  await sql([
    "DELETE FROM user_subject_images", "DELETE FROM media_storage_links", "DELETE FROM user_subjects",
    "DELETE FROM user_devices", "DELETE FROM user_state", "DELETE FROM anime_airing_schedule",
    "DELETE FROM external_service_credentials",
  ]);
  sources = Array.from({ length: 10 }, (_, index) => ({
    url: `/api/media-assets?v=${1700000000000 + index}`,
    key: `media-assets/${ownerHash}/gallery/${1700000000000 + index}`,
    bytes: images[index % images.length],
  }));
  sources.push(
    { url: "/api/device-assets?purpose=cover&v=1700000001000", key: `device-assets/${owner}/cover/1700000001000`, bytes: images[1] },
    { url: "/api/device-assets?purpose=receipt&v=1700000001001", key: `device-assets/${owner}/receipt/1700000001001`, bytes: images[2] },
    { url: "/api/avatar?v=1700000002000", key: `avatars/${ownerHash}/1700000002000`, bytes: images[0] },
    { url: "/api/background?v=1700000003000", key: `backgrounds/${ownerHash}/1700000003000`, bytes: images[2] },
  );
  for (const source of sources) await putObject(source.key, source.bytes);
  await sql([
    { sql: "INSERT INTO user_subjects (id,user_key,type,title,note,source,score,tags,metadata,updated_at) VALUES (10,?,'anime','备份作品','原始简介','manual',9,?,?,1700000000000)", params: [owner, '["百合"]', JSON.stringify({ backdropImage: sources[1].url, overview: "保留完整简介" })] },
    { sql: "INSERT INTO user_subjects (id,user_key,type,title,source,thumbnail,updated_at) VALUES (20,?,'visual','备份画廊','manual',?,1700000000000)", params: [owner, sources[0].url] },
    ...sources.slice(0, 10).map((source, index) => ({ sql: "INSERT INTO user_subject_images (id,user_key,subject_id,thumbnail,sort_order,is_cover,width,height,mime,created_at,updated_at) VALUES (?,?,20,?,?,?,1,1,'image/png',1700000000000,1700000000000)", params: [201 + index, owner, source.url, index, index === 0 ? 1 : 0] })),
    { sql: "INSERT INTO media_storage_links (id,user_key,media_id,provider,path,created_at,updated_at) VALUES (301,?,20,'mega','/archives/originals',1700000000000,1700000000000)", params: [owner] },
    { sql: "INSERT INTO user_devices (id,user_key,name,category,cover_image,receipt_image,cover_offset_x,updated_at) VALUES (401,?,'测试设备','audio',?,?,12.5,1700000000000)", params: [owner, sources[10].url, sources[11].url] },
    { sql: "INSERT INTO user_state (user_key,anime_json,avatar_image,background_version,primary_color,updated_at) VALUES (?,'[]',?,1700000003000,'#66CCFF',1700000000000)", params: [owner, sources[12].url] },
  ]);
});

test("complete archives stream portable ZIPs and restore database, media, devices, avatar and background after original loss", async () => {
  const sourceOnlyImage = {
    url: "/api/media-assets?v=1700000004000", key: `media-assets/${ownerHash}/gallery/1700000004000`, bytes: images[1],
  };
  sources.push(sourceOnlyImage);
  await putObject(sourceOnlyImage.key, sourceOnlyImage.bytes);
  const externalSource = "https://example.com/reference?original=1#unchanged";
  const multilineSource = `  ${sourceOnlyImage.url}  \r\n ${externalSource}   `;
  // This object is referenced only inside the multiline source field, so it
  // cannot accidentally enter the archive through a normal image column.
  await sql([{ sql: "UPDATE user_subjects SET source_url=? WHERE user_key=? AND id=10", params: [multilineSource, owner] }]);
  const before = await data();
  const backup = await createComplete();
  assert.equal(backup.status, "complete");
  assert.equal(backup.assetCount, 15);
  const downloaded = await download(backup.id);
  assert.equal(downloaded.manifest.assets.length, 15);
  assert.ok(downloaded.manifest.assets.some((asset) => asset.urls.includes(sourceOnlyImage.url)), "the local URL inside a multiline source must be archived");
  assert.equal(downloaded.entries.length, 4, "content-addressed identical PNGs should only be stored once in ZIP");
  assert.deepEqual(downloaded.manifest.data.tables, before.data.tables);
  const damagedZip = new Uint8Array(await downloaded.file.arrayBuffer());
  const imageEntry = downloaded.entries.find((entry) => entry.name.startsWith("assets/"));
  damagedZip[imageEntry.dataOffset + imageEntry.size - 1] ^= 1;
  await assert.rejects(readBackupZipEntry(new Blob([damagedZip]), imageEntry), /校验失败/);

  // Simulate loss of the old content and originals. The current empty state
  // can still be safely backed up before the requested exact restoration.
  await sql([
    "DELETE FROM user_subject_images", "DELETE FROM media_storage_links", "DELETE FROM user_subjects",
    "DELETE FROM user_devices", "DELETE FROM user_state",
  ]);
  for (const source of sources) await deleteObject(source.key);
  const restored = await restore(backup.id);
  assert.ok(restored.continuations > 0, "more than eight images must use resumable restoration");
  const after = await data();
  assert.deepEqual(after.data.counts, before.data.counts);
  const restoredSubject = after.data.tables.user_subjects.find((row) => row.id === 10);
  assert.equal(restoredSubject.note, "原始简介");
  const restoredSourceImage = restoredSubject.source_url.split("\r\n")[0].trim();
  assert.notEqual(restoredSourceImage, sourceOnlyImage.url);
  assert.equal(restoredSubject.source_url, multilineSource.replace(sourceOnlyImage.url, restoredSourceImage),
    "only the local URL may change; CRLF, surrounding spaces and the external URL must remain byte-for-byte unchanged");
  assert.equal(after.data.tables.user_devices[0].cover_offset_x, 12.5);
  assert.equal(new Set(after.data.tables.user_subject_images.map((row) => row.thumbnail)).size, 10,
    "different original image URLs must remain distinct even when their bytes have the same SHA-256");
  for (const [index, row] of after.data.tables.user_subject_images.entries()) {
    const response = await request(row.thumbnail);
    assert.equal(response.status, 200, row.thumbnail);
    assert.equal(sha256(Buffer.from(await response.arrayBuffer())), sha256(sources[index].bytes));
  }
  const device = after.data.tables.user_devices[0];
  const settings = after.data.tables.user_state[0];
  for (const [url, source] of [
    [device.cover_image, sources[10]], [device.receipt_image, sources[11]],
    [settings.avatar_image, sources[12]], [`/api/background?v=${settings.background_version}`, sources[13]],
    [JSON.parse(after.data.tables.user_subjects.find((row) => row.id === 10).metadata).backdropImage, sources[1]],
    [restoredSourceImage, sourceOnlyImage],
  ]) {
    const response = await request(url);
    assert.equal(response.status, 200, url);
    assert.equal(sha256(Buffer.from(await response.arrayBuffer())), sha256(source.bytes));
  }
  assert.equal((await request(sources[0].url)).status, 404, "restore should use new image references without overwriting missing originals");
  assert.equal((await request(sourceOnlyImage.url)).status, 404);
  const replay = await api("/api/backup/archive", restored.parameters);
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal((await data()).fingerprint, after.fingerprint);
  assert.ok((await list()).backups.some((item) => item.id === restored.preRestoreBackupId && item.kind === "before-restore" && item.status === "complete"));
});

test("missing original images cannot become a complete downloadable archive, and continuation can recover after repair", async () => {
  await deleteObject(sources[2].key);
  const created = await api("/api/backup/archives", { action: "create" });
  const id = created.body.backup.id;
  const result = await api("/api/backup/archives", { action: "continue", id });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.backup.status, "failed");
  assert.match(result.body.backup.error, /缺失/);
  assert.notEqual((await request(`/api/backup/archive?id=${id}`)).status, 200);
  assert.equal((await api("/api/backup/archive", { action: "preview", id })).status, 400);
  await putObject(sources[2].key, sources[2].bytes);
  assert.equal((await complete(id)).status, "complete");
  await download(id);
});

test("offline upload rejects changed data hashes and corrupt PNGs, then accepts the verified ZIP contents without touching live data", async () => {
  const current = await data();
  const original = await createComplete();
  const zip = await download(original.id);
  const clear = await request(`/__test/objects?prefix=${encodeURIComponent(backupPrefix)}`, { method: "DELETE" });
  assert.equal(clear.status, 200);
  const invalid = structuredClone(zip.manifest);
  invalid.data.tables.user_subjects[0].title = "tampered data";
  const rejected = await api("/api/backup/archive", { action: "upload-start", manifest: invalid });
  assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
  assert.match(rejected.body.error, /校验失败/);
  assert.equal((await data()).fingerprint, current.fingerprint);

  const started = await api("/api/backup/archive", { action: "upload-start", manifest: zip.manifest });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.missingAssets.length, 3);
  const id = started.body.id;
  const firstHash = started.body.missingAssets[0];
  const damaged = new Uint8Array(await zip.parts.get(`assets/${firstHash}`).arrayBuffer());
  damaged[damaged.length - 1] ^= 1;
  const badImage = await request(`/api/backup/archive?id=${id}&sha256=${firstHash}`, { method: "PUT", body: damaged, headers: { "content-type": "application/octet-stream" } });
  assert.equal(badImage.status, 400, await badImage.text());
  assert.equal((await api("/api/backup/archive", { action: "upload-finish", id })).status, 400);
  assert.equal((await data()).fingerprint, current.fingerprint);
  for (const hash of started.body.missingAssets) {
    const response = await request(`/api/backup/archive?id=${id}&sha256=${hash}`, { method: "PUT", body: await zip.parts.get(`assets/${hash}`).arrayBuffer(), headers: { "content-type": "application/octet-stream" } });
    assert.equal(response.status, 200, await response.text());
  }
  const finished = await api("/api/backup/archive", { action: "upload-finish", id });
  assert.equal(finished.status, 200, JSON.stringify(finished.body));
  assert.equal(finished.body.backup.status, "complete");
  assert.equal((await data()).fingerprint, current.fingerprint);
  assert.deepEqual((await download(id)).manifest, zip.manifest);
});

test("restore previews become invalid after a concurrent live edit", async () => {
  const backup = await createComplete();
  const preview = await api("/api/backup/archive", { action: "preview", id: backup.id });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  await sql([{ sql: "UPDATE user_subjects SET note='预览后的新编辑' WHERE user_key=? AND id=10", params: [owner] }]);
  const changed = await data();
  const result = await api("/api/backup/archive", { action: "restore", id: backup.id, expectedFingerprint: preview.body.expectedFingerprint, confirmed: true });
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal((await data()).fingerprint, changed.fingerprint);
  assert.equal((await list()).backups.filter((item) => item.kind === "before-restore").length, 0);
});

test("daily cron completes one snapshot per China date and respects persisted settings and the component switch", async () => {
  assert.equal((await list()).settings.enabled, true);
  for (let n = 0; n < 2; n++) {
    const result = await api("/__test/cron", { now: "2026-11-24T20:05:00.000Z" });
    assert.equal(result.status, 200, JSON.stringify(result.body));
  }
  let current = await list();
  assert.deepEqual(current.backups.map((item) => [item.id, item.kind, item.status]), [["daily-2026-11-25", "scheduled", "complete"]]);
  const disabled = await api("/api/backup/archives", { action: "configure", enabled: false, retentionDays: 7 });
  assert.equal(disabled.status, 200);
  await api("/__test/cron", { now: "2026-11-25T20:05:00.000Z" });
  assert.equal((await list()).backups.length, 1);
  await api("/api/backup/archives", { action: "configure", enabled: true, retentionDays: 7 });
  await api("/__test/cron", { now: "2026-11-25T20:05:00.000Z", componentEnabled: "false" });
  assert.equal((await list()).backups.length, 1);
  const resumed = await api("/__test/cron", { now: "2026-11-25T20:05:00.000Z" });
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  current = await list();
  assert.equal(current.settings.enabled, true);
  assert.equal(current.settings.retentionDays, 7);
  assert.equal(current.backups.length, 2);
  assert.ok(current.backups.every((item) => item.status === "complete"));
});

test("cron exposes an original snapshot-read failure before any record exists and clears it after a successful same-day retry", async () => {
  const now = "2026-11-24T20:05:00.000Z";
  const failed = await api("/__test/cron", { now, failBatch: true });
  assert.equal(failed.status, 500, JSON.stringify(failed.body));
  assert.equal(failed.body.sameError, true, "the original D1 error must be rethrown without replacement");
  assert.equal(failed.body.error, "injected D1 snapshot batch failure");
  const afterFailure = await list();
  assert.equal(afterFailure.backups.length, 0, "a failed read cannot create a complete or partial snapshot record");
  assert.match(afterFailure.lastError, /injected D1 snapshot batch failure/);

  const retried = await api("/__test/cron", { now });
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  const afterRetry = await list();
  assert.equal(afterRetry.lastError, null);
  assert.equal(afterRetry.backups.length, 1);
  const backup = afterRetry.backups[0];
  assert.equal(backup.id, "daily-2026-11-25");
  assert.equal(backup.status, "complete");
  assert.equal(backup.assetCount, 14);
  assert.deepEqual((await download(backup.id)).manifest.data.tables, (await data()).data.tables);
});

test("401 unique images download as two complete-manifest ZIP parts with bounded R2 reads", async () => {
  const snapshot = (await data()).data;
  const blobs = Array.from({ length: 401 }, (_, index) => {
    const bytes = png(index % 256, Math.floor(index / 256), 160);
    return [sha256(bytes), [...bytes]];
  });
  const assets = blobs.map(([hash, bytes], index) => ({
    kind: "media", urls: [`/api/media-assets?v=${1700100000000 + index}`],
    sha256: hash, size: bytes.length, contentType: "image/png", crc32: backupCrc32(Uint8Array.from(bytes)),
  }));
  assert.equal(new Set(assets.map((asset) => asset.sha256)).size, 401);
  const image = snapshot.tables.user_subject_images[0];
  const gallery = snapshot.tables.user_subjects.find((row) => row.id === 20);
  snapshot.tables = {
    user_subjects: Array.from({ length: 7 }, (_, index) => ({
      ...gallery, id: 20 + index, title: `分包画廊 ${index + 1}`, thumbnail: assets[index * 60].urls[0],
    })),
    user_subject_images: assets.map((asset, index) => ({
      ...image, id: 201 + index, subject_id: 20 + Math.floor(index / 60), thumbnail: asset.urls[0],
      sort_order: index % 60, is_cover: index % 60 === 0 ? 1 : 0,
    })),
    media_storage_links: [], user_devices: [], user_state: [], anime_airing_schedule: [],
  };
  snapshot.counts = { subjects: 7, images: 401, storageLinks: 0, devices: 0, settings: 0, schedules: 0 };
  const input = { data: snapshot, assets, blobs };
  const hashes = new Set();
  let firstManifest;
  for (const part of [1, 2]) {
    const response = await request("/__test/split-download", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...input, part }),
    });
    assert.equal(response.status, 200, response.status === 200 ? undefined : await response.text());
    const expectedImages = part === 1 ? 400 : 1;
    assert.equal(Number(response.headers.get("x-test-download-parts")), 2);
    assert.equal(Number(response.headers.get("x-test-asset-reads")), expectedImages);
    assert.equal(Number(response.headers.get("x-test-total-reads")), expectedImages + 1, "only the archive record adds a non-image R2 read");
    assert.match(response.headers.get("content-disposition"), new RegExp(`-part-0${part}-of-2\\.zip`));
    const file = await response.blob();
    const entries = await inspectBackupZip(file);
    assert.equal(entries.length, expectedImages + 1);
    const manifestText = await (await readBackupZipEntry(file, entries.find((entry) => entry.name === "backup.json"))).text();
    const manifest = JSON.parse(manifestText);
    assert.deepEqual(manifest.data.tables, snapshot.tables);
    assert.deepEqual(manifest.assets, assets);
    if (firstManifest === undefined) firstManifest = manifestText;
    else assert.equal(manifestText, firstManifest, "every part must carry the same full manifest");
    for (const entry of entries.filter((entry) => entry.name.startsWith("assets/"))) {
      const bytes = Buffer.from(await (await readBackupZipEntry(file, entry)).arrayBuffer());
      const hash = entry.name.slice("assets/".length);
      assert.equal(sha256(bytes), hash);
      assert.equal(hashes.has(hash), false, "no image may be repeated across split ZIPs");
      hashes.add(hash);
    }
  }
  assert.deepEqual(hashes, new Set(assets.map((asset) => asset.sha256)));
  const invalid = await api("/__test/split-download", { ...input, part: 3 });
  assert.equal(invalid.status, 400, JSON.stringify(invalid.body));
  assert.match(invalid.body.error, /分包编号无效/);
});

test("Baidu OAuth uses the official endpoint, session-bound one-use state, and encrypted credentials for scheduled uploads", async () => {
  const path = "/api/backup/providers/baidu";
  const body = { appKey: "fixtureKey", secretKey: "fixtureSecret" };
  const anonymous = await request(path, { method: "POST", headers: { cookie: "", "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(anonymous.status, 401);
  const foreign = await request(path, { method: "POST", headers: { origin: "https://foreign.example", "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(foreign.status, 403);
  const start = await api(path, body);
  assert.equal(start.status, 200);
  const url = new URL(start.body.authorizationUrl);
  assert.equal(url.origin + url.pathname, "https://openapi.baidu.com/oauth/2.0/authorize");
  assert.equal(url.searchParams.get("client_id"), "fixtureKey");
  assert.equal(url.searchParams.get("scope"), "basic,netdisk");
  assert.ok(!url.href.includes("fixtureSecret"));
  const state = url.searchParams.get("state");
  assert.ok(state);
  const invalid = await request(path + "?state=invalid&code=fixtureCode", { redirect: "manual" });
  assert.equal(invalid.status, 303);
  assert.match(invalid.headers.get("location"), /baidu=invalid/);
  const unauthenticated = await request(path + "?state=" + state + "&code=fixtureCode", { redirect: "manual", headers: { cookie: "" } });
  assert.equal(unauthenticated.status, 401);
  const finish = await request(path + "?state=" + state + "&code=fixtureCode", { redirect: "manual" });
  assert.equal(finish.status, 303);
  assert.match(finish.headers.get("location"), /baidu=success/);
  const status = await api("/api/backup/providers");
  assert.equal(status.body.providers[0].configured, true);
  assert.equal(status.body.providers[0].ready, true);
  assert.ok(!JSON.stringify(status.body).includes("fixtureAccess"));
  assert.ok(!JSON.stringify(status.body).includes("fixtureSecret"));
  const [rows] = await sql(["SELECT provider,token_ciphertext FROM external_service_credentials"]);
  assert.equal(rows.results.length, 1);
  assert.equal(rows.results[0].provider, "baidu");
  assert.match(rows.results[0].token_ciphertext, /^v1\./);
  assert.ok(!rows.results[0].token_ciphertext.includes("fixtureSecret"));
  const clock = Date.now();
  await putObject(sources[0].key, Buffer.concat([images[0], Buffer.alloc(4 * 1024 * 1024, 0x3a)]));
  assert.equal((await api("/__test/cron", { now: clock })).status, 200);
  // An already finished split archive must migrate immediately even with a future due date.
  const legacy = await sql(["SELECT metadata FROM external_service_credentials WHERE provider='baidu'"]);
  const metadata = JSON.parse(legacy[0].results[0].metadata);
  await sql([{ sql: "UPDATE external_service_credentials SET metadata=? WHERE provider='baidu'", params: [JSON.stringify({ ...metadata, completed: "daily-" + new Date(clock + 8 * 3600000).toISOString().slice(0, 10), nextDue: clock + 5 * 86400000 })] }]);
  const firstCopy = await api("/__test/baidu-copy", { now: clock });
  assert.equal(firstCopy.status, 200);
  assert.deepEqual(firstCopy.body.calls, ["mkdir", "precreate", "locate", "block", "locate", "block", "create"], JSON.stringify(firstCopy.body.calls));
  assert.match(firstCopy.body.path, /^\/apps\/备份\/月下集备份\/月下集-\d{4}-\d{2}-\d{2}\.zip$/);
  const uploaded = new Blob([Buffer.from(firstCopy.body.archive, "base64")]);
  const entries = await inspectBackupZip(uploaded);
  const manifest = JSON.parse(await (await readBackupZipEntry(uploaded, entries[0])).text());
  const hashes = new Set(manifest.assets.map(a => a.sha256));
  assert.ok(hashes.size > 0);
  assert.equal(entries.length, hashes.size + 1);
  for (const image of entries.slice(1)) {
    const hash = sha256(Buffer.from(await (await readBackupZipEntry(uploaded, image)).arrayBuffer()));
    assert.equal(image.name, "assets/" + hash);
    assert.ok(hashes.delete(hash));
  }
  assert.match((await api("/api/backup/providers")).body.providers[0].backupStatus, /已保存/);
  const early = await api("/__test/baidu-copy", { now: clock + 4 * 86400000 });
  assert.deepEqual(early.body.calls, []);
  for (const rapid of ["nested", "lookup", "wrong-size"]) {
    await sql([{ sql: "UPDATE external_service_credentials SET metadata=? WHERE provider='baidu'", params: [JSON.stringify(metadata)] }]);
    const response = await api("/__test/baidu-copy", { now: clock, rapid, appName: "月下集测试" });
    assert.deepEqual(response.body.calls, rapid === "nested" ? ["mkdir", "precreate"] : ["mkdir", "precreate", "search"]);
    const [stored] = await sql(["SELECT metadata FROM external_service_credentials WHERE provider='baidu'"]);
    const outcome = JSON.parse(stored.results[0].metadata);
    if (rapid === "wrong-size") {
      assert.equal(outcome.file, undefined);
      assert.match(outcome.error, /未确认/);
    } else {
      assert.equal(outcome.file.path, firstCopy.body.path.replace("/apps/备份/", "/apps/月下集测试/"));
      assert.equal(outcome.file.size, uploaded.size);
      assert.equal(outcome.file.id, "123456789012345678");
    }
  }
  const replay = await request(path + "?state=" + state + "&code=fixtureCode", { redirect: "manual" });
  assert.match(replay.headers.get("location"), /baidu=invalid/);
  const renewed = await api(path, { reuse: true });
  assert.equal(renewed.status, 200);
  const renewedState = new URL(renewed.body.authorizationUrl).searchParams.get("state");
  const unlink = await request("/api/backup/providers", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "baidu" }) });
  assert.equal(unlink.status, 200);
  const late = await request(path + "?state=" + renewedState + "&code=fixtureCode", { redirect: "manual" });
  assert.match(late.headers.get("location"), /baidu=invalid/);
  assert.equal((await api("/api/backup/providers")).body.providers[0].configured, false);
});

test("uploading the original cover after ZIP import skips the write even without historical receipts", async () => {
  await sql(["DELETE FROM agent_operations", { sql: "INSERT INTO user_subjects (id,user_key,type,title,updated_at) VALUES (30,?,'music','音乐',1)", params: [owner] }]);
  const send = key => api("/__test/cover-upload", { input: [...images[0]], key });
  const first = await send("cover-before-restore");
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const backup = await createComplete();
  const { manifest } = await download(backup.id);
  assert.deepEqual(manifest.coverHashes, [{ image: first.body.image, sourceHash: sha256(images[0]) }]);
  await sql(["DELETE FROM agent_operations"]);
  const uploaded = await api("/api/backup/archive", { action: "upload-start", manifest });
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
  const id = uploaded.body.backup.id;
  assert.equal((await api("/api/backup/archive", { action: "upload-finish", id })).status, 200);
  await restore(id);
  const current = (await data()).data.tables.user_subjects.find(row => row.id === 30).image;
  assert.notEqual(current, first.body.image);
  const keys = () => api("/__test/objects?prefix=media-assets/");
  const before = (await keys()).body.keys;
  const again = await send("cover-after-restore");
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.skipped, true);
  assert.equal(again.body.image, current);
  assert.deepEqual((await keys()).body.keys, before);
});

test("an older manifest can reuse local receipts and resume the same pending safety snapshot", async () => {
  await sql(["DELETE FROM agent_operations", { sql: "INSERT INTO user_subjects (id,user_key,type,title,updated_at) VALUES (30,?,'music','音乐',1)", params: [owner] }]);
  const send = key => api("/__test/cover-upload", { input: [...images[0]], key });
  const first = await send("legacy-cover-original");
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const backup = await createComplete();
  const { manifest } = await download(backup.id);
  delete manifest.coverHashes;
  const uploaded = await api("/api/backup/archive", { action: "upload-start", manifest });
  const id = uploaded.body.backup.id;
  assert.equal((await api("/api/backup/archive", { action: "upload-finish", id })).status, 200);
  const preview = await api("/api/backup/archive", { action: "preview", id });
  const request = { action: "restore", confirmed: true, expectedFingerprint: preview.body.expectedFingerprint, id };
  const start = await api("/api/backup/archive", request);
  assert.equal(start.body.backup.status, "pending");
  request.preRestoreBackupId = start.body.preRestoreBackupId;
  const repeat = await api("/api/backup/archive", request);
  assert.equal(repeat.status, 202, JSON.stringify(repeat.body));
  assert.equal(repeat.body.backup.id, request.preRestoreBackupId);
  assert.equal((await list()).backups.filter(row => row.kind === "before-restore").length, 1);
  await complete(request.preRestoreBackupId);
  let result = await api("/api/backup/archive", request);
  while (result.status === 202 && result.body.needsMore) result = await api("/api/backup/archive", request);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const again = await send("legacy-cover-after-restore");
  assert.equal(again.body.skipped, true);
  assert.notEqual(again.body.image, first.body.image);
  await sql(["UPDATE user_subjects SET image=NULL WHERE id=30"]);
  const replaced = await send("legacy-cover-replaced");
  assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
  assert.notEqual(replaced.body.skipped, true);
  assert.notEqual(replaced.body.image, again.body.image);
});

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import wrangler from "wrangler";
import { siteBackupWriteError } from "../app/lib/site-backup-data.ts";

const { unstable_splitSqlQuery: splitSqlQuery, unstable_dev } = wrangler;
const owner = "site-backup-owner";
let worker;
let cookie;

async function api(path, body, options = {}) {
  const response = await worker.fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...options.headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json();
  return { status: response.status, body: payload };
}

async function sql(statements) {
  const result = await api("/__test/sql", statements);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body.results;
}

async function snapshot() {
  const result = await api("/__test/site/export");
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
}

async function fingerprint(backup) {
  const result = await api("/__test/site/fingerprint", backup);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body.fingerprint;
}

async function collection() {
  const result = await api("/api/backup/export");
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
}

function recountCollection(backup) {
  backup.counts = {
    subjects: backup.subjects.length,
    images: backup.subjects.reduce((sum, subject) => sum + subject.images.length, 0),
    storageLinks: backup.subjects.reduce((sum, subject) => sum + subject.storageLinks.length, 0),
  };
  return backup;
}

function businessContent(backup) {
  const copy = structuredClone(backup);
  delete copy.exportedAt;
  return copy;
}

before(async () => {
  worker = await unstable_dev("tests/fixtures/site-backup-data-worker.mjs", {
    config: "tests/fixtures/site-backup-data-wrangler.jsonc", envFiles: ["tests/fixtures/.env.test"],
    persist: false, local: true, logLevel: "error",
    experimental: { disableExperimentalWarning: true, disableDevRegistry: true, showInteractiveDevSession: false, testMode: true, watch: false },
  });
  const migrations = (await readdir("drizzle")).filter((name) => name.endsWith(".sql")).sort();
  for (const name of migrations) await sql(splitSqlQuery(await readFile(`drizzle/${name}`, "utf8")));
  const setup = await worker.fetch("/__test/setup", { method: "POST" });
  assert.equal(setup.status, 200, await setup.text());
  cookie = setup.headers.get("set-cookie")?.split(";")[0];
});

after(async () => { await worker?.stop(); });

test("ambiguous D1 service errors never claim the restore definitely rolled back", () => {
  const error = siteBackupWriteError(new Error("D1_ERROR: internal error"));
  assert.equal(error.code, "backup_outcome_unknown");
  assert.equal(error.rolledBack, false);
  assert.equal(siteBackupWriteError(new Error("D1_ERROR: UNIQUE constraint failed: user_subjects.id: SQLITE_CONSTRAINT")).rolledBack, true);
});

beforeEach(async () => {
  await sql([
    "DROP TRIGGER IF EXISTS fail_site_backup_restore",
    "DROP TRIGGER IF EXISTS fail_collection_backup_import",
    "DELETE FROM user_subject_images", "DELETE FROM media_storage_links", "DELETE FROM user_subjects",
    "DELETE FROM user_devices", "DELETE FROM user_state", "DELETE FROM anime_airing_schedule",
    {
      sql: "INSERT INTO user_subjects (id,user_key,type,subject_id,title,note,progress,total,score,tags,character_tags,metadata,updated_at) VALUES (10,?,'anime',1000,'备份动画','原备注',4,12,9,?,?,?,1700000000000)",
      params: [owner, JSON.stringify(["普通标签"]), JSON.stringify(["历史角色标签"]), JSON.stringify({ coverZoom: 125, coverOffsetX: 12.5 })],
    },
    { sql: "INSERT INTO user_subjects (id,user_key,type,title,thumbnail,updated_at) VALUES (20,?,'visual','备份画廊','/api/media-assets?v=fixture_gallery_001',1700000000000)", params: [owner] },
    { sql: "INSERT INTO user_subject_images (id,user_key,subject_id,thumbnail,sort_order,is_cover,width,height,mime,created_at,updated_at) VALUES (201,?,20,'/api/media-assets?v=fixture_gallery_001',0,1,800,600,'image/webp',1700000000000,1700000000000)", params: [owner] },
    { sql: "INSERT INTO media_storage_links (id,user_key,media_id,provider,url,path,is_primary,state,object_count,total_bytes,manifest_sha256,verified_at,created_at,updated_at) VALUES (301,?,20,'mega','https://example.com/share','/archive/fixture',1,'verified',1,1024,?,1700000000000,1700000000000,1700000000000)", params: [owner, "a".repeat(64)] },
    { sql: "INSERT INTO user_devices (id,user_key,name,category,price,tags,rating,review,cover_image,cover_offset_x,cover_offset_y,updated_at) VALUES (401,?,'测试耳机','audio',199.5,?,8,'原评测','/api/media-assets?v=fixture_device_001',12.5,-5,1700000000000)", params: [owner, JSON.stringify(["有线"])] },
    { sql: "INSERT INTO user_state (user_key,anime_json,collections_json,media_order_json,avatar_image,primary_color,accent_color,updated_at) VALUES (?,'[]',?,?,'/api/avatar?v=fixture_avatar_001','#66CCFF','#8B8CD8',1700000000000)", params: [owner, JSON.stringify(["珍藏"]), JSON.stringify(["anime", "music"])] },
    "INSERT INTO anime_airing_schedule (id,subject_id,title,weekday,air_time,season,year,source,last_checked,created_at,updated_at) VALUES (501,1000,'自定义放送',2,'22:00','autumn',2026,'custom',1700000000000,1700000000000,1700000000000)",
    "INSERT INTO user_subjects (id,user_key,type,title,updated_at) VALUES (9010,'other-owner','anime','其他账户收藏',1700000000000)",
    "INSERT INTO user_subject_images (id,user_key,subject_id,thumbnail,created_at,updated_at) VALUES (9201,'other-owner',9010,'/private/other.webp',1700000000000,1700000000000)",
    "INSERT INTO media_storage_links (id,user_key,media_id,provider,path,created_at,updated_at) VALUES (9301,'other-owner',9010,'mega','/private/other',1700000000000,1700000000000)",
    "INSERT INTO user_devices (id,user_key,name,category,updated_at) VALUES (9401,'other-owner','其他账户设备','audio',1700000000000)",
    "INSERT INTO user_state (user_key,anime_json,updated_at) VALUES ('other-owner','[]',1700000000000)",
  ]);
});

test("site export captures all business tables, historical tags and settings without credentials or other owners", async () => {
  const backup = await snapshot();
  assert.equal(backup.format, "yuexiaji-site-backup");
  assert.equal(backup.version, 1);
  assert.deepEqual(backup.counts, { subjects: 2, images: 1, storageLinks: 1, devices: 1, settings: 1, schedules: 1 });
  assert.deepEqual(Object.keys(backup.tables).sort(), ["anime_airing_schedule", "media_storage_links", "user_devices", "user_state", "user_subject_images", "user_subjects"]);
  assert.equal(backup.tables.user_subjects[0].character_tags, '["历史角色标签"]');
  assert.equal(backup.tables.user_devices[0].cover_offset_x, 12.5);
  assert.equal(backup.tables.user_state[0].primary_color, "#66CCFF");
  assert.equal(backup.tables.anime_airing_schedule[0].source, "custom");
  for (const row of Object.values(backup.tables).flat()) assert.equal("user_key" in row, false);
  for (const key of ["anime_json", "openclaw_url", "openclaw_agent"]) assert.equal(key in backup.tables.user_state[0], false);
  const serialized = JSON.stringify(backup);
  for (const excluded of ["excluded-password-hash", "admin_account", "admin_sessions", "other-owner", "其他账户"]) assert.equal(serialized.includes(excluded), false, excluded);
  assert.equal(await fingerprint(backup), await fingerprint({ ...backup, exportedAt: "2026-11-24T12:00:00.000Z" }));
});

test("backup preserves supported legacy X handles and fractional preferences", async () => {
  await sql([
    { sql: "UPDATE user_subjects SET twitter_source='@example_artist' WHERE id=20 AND user_key=?", params: [owner] },
    { sql: "UPDATE user_state SET softness=72.5 WHERE user_key=?", params: [owner] },
  ]);
  const backup = await snapshot();
  assert.equal(backup.tables.user_subjects.find((row) => row.id === 20).twitter_source, "@example_artist");
  assert.equal(backup.tables.user_state[0].softness, 72.5);
  const json = await collection();
  assert.equal(json.subjects.find((row) => row.id === 20).twitterSource, "@example_artist");
  const restored = await api("/__test/site/restore", { backup, expectedCurrent: backup });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.deepEqual(businessContent(await snapshot()), businessContent(backup));
});

const multilineSources = [
  "https://example.com/source-one\nhttp://example.com/source-two",
  "https://example.com/source-one\r\nhttps://example.com/source-two",
  "  https://example.com/source-one  \r\n https://example.com/source-two   ",
];

test("site export and exact restore preserve multiline source URLs including original line endings and surrounding spaces", async () => {
  for (const source of multilineSources) {
    await sql([
      { sql: "UPDATE user_subjects SET source_url=? WHERE user_key=? AND id=10", params: [source, owner] },
      { sql: "UPDATE user_subject_images SET source_url=? WHERE user_key=? AND id=201", params: [source, owner] },
    ]);
    const backup = await snapshot();
    assert.equal(backup.tables.user_subjects.find((row) => row.id === 10).source_url, source);
    assert.equal(backup.tables.user_subject_images[0].source_url, source);
    await sql([
      { sql: "UPDATE user_subjects SET source_url='https://example.com/edited' WHERE user_key=? AND id=10", params: [owner] },
      { sql: "UPDATE user_subject_images SET source_url='https://example.com/edited' WHERE user_key=? AND id=201", params: [owner] },
    ]);
    const restored = await api("/__test/site/restore", { backup, expectedCurrent: await snapshot() });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.deepEqual(businessContent(await snapshot()), businessContent(backup));
    const saved = await sql([
      { sql: "SELECT source_url FROM user_subjects WHERE user_key=? AND id=10", params: [owner] },
      { sql: "SELECT source_url FROM user_subject_images WHERE user_key=? AND id=201", params: [owner] },
    ]);
    assert.deepEqual(saved.map((result) => result.results[0].source_url), [source, source]);
  }
});

test("legacy JSON export and merge import preserve multiline source URLs byte for byte", async () => {
  for (const source of multilineSources) {
    await sql([
      { sql: "UPDATE user_subjects SET source_url=? WHERE user_key=? AND id=10", params: [source, owner] },
      { sql: "UPDATE user_subject_images SET source_url=? WHERE user_key=? AND subject_id=20", params: [source, owner] },
    ]);
    const backup = await collection();
    assert.equal(backup.subjects.find((row) => row.id === 10).sourceUrl, source);
    assert.equal(backup.subjects.find((row) => row.id === 20).images[0].sourceUrl, source);
    await sql([
      { sql: "UPDATE user_subjects SET source_url='https://example.com/edited' WHERE user_key=? AND id=10", params: [owner] },
      { sql: "UPDATE user_subject_images SET source_url='https://example.com/edited' WHERE user_key=? AND subject_id=20", params: [owner] },
    ]);
    const imported = await api("/api/backup/import", { mode: "import", confirmed: true, backup });
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    const after = await collection();
    assert.equal(after.subjects.find((row) => row.id === 10).sourceUrl, source);
    assert.equal(after.subjects.find((row) => row.id === 20).images[0].sourceUrl, source);
    const saved = await sql([
      { sql: "SELECT source_url FROM user_subjects WHERE user_key=? AND id=10", params: [owner] },
      { sql: "SELECT source_url FROM user_subject_images WHERE user_key=? AND subject_id=20", params: [owner] },
    ]);
    assert.deepEqual(saved.map((result) => result.results[0].source_url), [source, source]);
  }
});

test("unsafe source lines and multiline image or storage addresses reject both import formats without writes", async () => {
  const current = await snapshot();
  const legacy = await collection();
  const cases = [
    {
      site: (backup) => { backup.tables.user_subjects[0].source_url = "https://example.com/source\njavascript:alert(1)"; },
      collection: (backup) => { backup.subjects[0].sourceUrl = "https://example.com/source\njavascript:alert(1)"; },
    },
    {
      site: (backup) => { backup.tables.user_subject_images[0].source_url = "https://example.com/source\r\n data:text/html,unsafe "; },
      collection: (backup) => { backup.subjects.find((row) => row.id === 20).images[0].sourceUrl = "https://example.com/source\r\n data:text/html,unsafe "; },
    },
    {
      site: (backup) => { backup.tables.user_subject_images[0].thumbnail = multilineSources[0]; },
      collection: (backup) => { backup.subjects.find((row) => row.id === 20).images[0].thumbnail = multilineSources[0]; },
    },
    {
      site: (backup) => { backup.tables.media_storage_links[0].url = multilineSources[0]; },
      collection: (backup) => { backup.subjects.find((row) => row.id === 20).storageLinks[0].url = multilineSources[0]; },
    },
  ];
  for (const invalid of cases) {
    const fullBackup = structuredClone(current);
    fullBackup.tables.user_subjects[0].note = "invalid import must not apply this valid edit";
    invalid.site(fullBackup);
    const restored = await api("/__test/site/restore", { backup: fullBackup, expectedCurrent: current });
    assert.equal(restored.status, 400, JSON.stringify(restored.body));
    assert.deepEqual(businessContent(await snapshot()), businessContent(current));
    const collectionBackup = structuredClone(legacy);
    collectionBackup.subjects[0].note = "invalid import must not apply this valid edit";
    invalid.collection(collectionBackup);
    const imported = await api("/api/backup/import", { mode: "import", confirmed: true, backup: collectionBackup });
    assert.equal(imported.status, 400, JSON.stringify(imported.body));
    assert.deepEqual(businessContent(await snapshot()), businessContent(current));
  }
});

test("full restore exactly restores business data and removes later additions while preserving other owners and authentication", async () => {
  const backup = await snapshot();
  const beforeOthers = await sql([
    "SELECT * FROM user_subjects WHERE user_key='other-owner'",
    "SELECT * FROM user_subject_images WHERE user_key='other-owner'",
    "SELECT * FROM media_storage_links WHERE user_key='other-owner'",
    "SELECT * FROM user_devices WHERE user_key='other-owner'",
    "SELECT * FROM user_state WHERE user_key='other-owner'",
    "SELECT * FROM admin_account", "SELECT * FROM admin_sessions",
  ]);
  await sql([
    { sql: "UPDATE user_subjects SET title='已修改',character_tags='[]' WHERE user_key=?", params: [owner] },
    { sql: "DELETE FROM user_subject_images WHERE user_key=?", params: [owner] },
    { sql: "DELETE FROM media_storage_links WHERE user_key=?", params: [owner] },
    { sql: "INSERT INTO user_subjects (id,user_key,type,title,updated_at) VALUES (30,?,'music','后加歌曲',1700000000001)", params: [owner] },
    { sql: "UPDATE user_devices SET cover_offset_x=0,review='变更' WHERE user_key=?", params: [owner] },
    { sql: "UPDATE user_state SET primary_color='#FFFFFF' WHERE user_key=?", params: [owner] },
    "UPDATE anime_airing_schedule SET title='变更的放送'",
  ]);
  const current = await snapshot();
  const restored = await api("/__test/site/restore", { backup, expectedCurrent: current });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.deepEqual(businessContent(await snapshot()), businessContent(backup));
  const afterOthers = await sql([
    "SELECT * FROM user_subjects WHERE user_key='other-owner'",
    "SELECT * FROM user_subject_images WHERE user_key='other-owner'",
    "SELECT * FROM media_storage_links WHERE user_key='other-owner'",
    "SELECT * FROM user_devices WHERE user_key='other-owner'",
    "SELECT * FROM user_state WHERE user_key='other-owner'",
    "SELECT * FROM admin_account", "SELECT * FROM admin_sessions",
  ]);
  assert.deepEqual(afterOthers.map((result) => result.results), beforeOthers.map((result) => result.results));
});

test("a SQL failure after deletes and earlier inserts rolls the complete site restore back", async () => {
  const backup = await snapshot();
  await sql([{ sql: "UPDATE user_subjects SET title='导入前现状' WHERE user_key=? AND id=10", params: [owner] }]);
  const current = await snapshot();
  await sql(["CREATE TRIGGER fail_site_backup_restore BEFORE INSERT ON user_devices WHEN NEW.user_key='site-backup-owner' BEGIN SELECT RAISE(ABORT,'injected device restore failure'); END"]);
  const result = await api("/__test/site/restore", { backup, expectedCurrent: current });
  assert.ok(result.status >= 400, JSON.stringify(result.body));
  await sql(["DROP TRIGGER fail_site_backup_restore"]);
  assert.deepEqual(businessContent(await snapshot()), businessContent(current));
});

test("a concurrent change immediately before the write batch rejects restore without overwriting that change", async () => {
  const backup = await snapshot();
  await sql([{ sql: "UPDATE user_subjects SET note='当前备注' WHERE user_key=? AND id=10", params: [owner] }]);
  const current = await snapshot();
  const result = await api("/__test/site/restore-with-race", { backup, expectedCurrent: current });
  assert.equal(result.body.raced, true, JSON.stringify(result.body));
  assert.equal(result.status, 409, JSON.stringify(result.body));
  const expected = structuredClone(current);
  expected.tables.user_devices[0].review = "concurrent edit before commit";
  assert.deepEqual(businessContent(await snapshot()), businessContent(expected));
});

test("site validation rejects unknown data, duplicate IDs, orphan relations and unsafe URLs before any write", async () => {
  const valid = await snapshot();
  const mutations = [
    (backup) => { backup.tables.admin_account = []; },
    (backup) => { backup.tables.user_subjects[0].user_key = "other-owner"; },
    (backup) => { backup.tables.user_subjects[1].id = backup.tables.user_subjects[0].id; },
    (backup) => { backup.tables.user_subject_images[0].subject_id = 9999; },
    (backup) => { backup.tables.media_storage_links[0].media_id = 9999; },
    (backup) => { backup.tables.media_storage_links[0].url = "javascript:alert(1)"; },
    (backup) => { backup.tables.user_subject_images[0].thumbnail = "https://account:password@example.com/x.webp"; },
    (backup) => { backup.tables.user_subjects[0].id = "10"; },
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(valid);
    mutate(invalid);
    const parsed = await api("/__test/site/parse", invalid);
    assert.equal(parsed.status, 400, JSON.stringify(parsed.body));
    const restored = await api("/__test/site/restore", { backup: invalid, expectedCurrent: valid });
    assert.equal(restored.status, 400, JSON.stringify(restored.body));
  }
  assert.deepEqual(businessContent(await snapshot()), businessContent(valid));
});

test("restoring IDs occupied by another owner fails atomically instead of replacing that owner's data", async () => {
  const before = await snapshot();
  const collision = structuredClone(before);
  collision.tables.user_subjects[0].id = 9010;
  const result = await api("/__test/site/restore", { backup: collision, expectedCurrent: before });
  assert.ok(result.status >= 400, JSON.stringify(result.body));
  assert.deepEqual(businessContent(await snapshot()), businessContent(before));
  const [other] = await sql(["SELECT title FROM user_subjects WHERE id=9010 AND user_key='other-owner'"]);
  assert.equal(other.results[0].title, "其他账户收藏");
});

test("malformed cross-owner foreign keys are rejected before a restore can cascade into another owner's rows", async () => {
  const backup = await snapshot();
  await sql([
    "INSERT INTO user_subject_images (id,user_key,subject_id,thumbnail,created_at,updated_at) VALUES (9990,'other-owner',20,'/private/cross-owner.webp',1700000000000,1700000000000)",
    "INSERT INTO media_storage_links (id,user_key,media_id,provider,path,created_at,updated_at) VALUES (9991,'other-owner',20,'mega','/private/cross-owner',1700000000000,1700000000000)",
  ]);
  const result = await api("/__test/site/restore", { backup, expectedCurrent: await snapshot() });
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.deepEqual(businessContent(await snapshot()), businessContent(backup));
  const others = await sql([
    "SELECT id FROM user_subject_images WHERE id=9990 AND user_key='other-owner'",
    "SELECT id FROM media_storage_links WHERE id=9991 AND user_key='other-owner'",
  ]);
  assert.deepEqual(others.map((item) => item.results), [[{ id: 9990 }], [{ id: 9991 }]]);
});

test("site restore handles more than one D1 parameter batch while preserving every image and storage reference", async () => {
  const generated = JSON.stringify(Array.from({ length: 140 }, (_, index) => index));
  await sql([
    {
      sql: "INSERT INTO user_subjects (id,user_key,type,title,source,updated_at) SELECT 10000+value,?,'visual','批量画廊 '||value,'manual',1700000000000 FROM json_each(?)",
      params: [owner, generated],
    },
    {
      sql: "INSERT INTO user_subject_images (id,user_key,subject_id,thumbnail,created_at,updated_at) SELECT 20000+value,?,10000+value,'/api/media-assets?v=bulk_backup_'||value,1700000000000,1700000000000 FROM json_each(?)",
      params: [owner, generated],
    },
    {
      sql: "INSERT INTO media_storage_links (id,user_key,media_id,provider,path,created_at,updated_at) SELECT 30000+value,?,10000+value,'mega','/bulk/'||value,1700000000000,1700000000000 FROM json_each(?)",
      params: [owner, generated],
    },
  ]);
  const backup = await snapshot();
  assert.equal(backup.counts.subjects, 142);
  assert.equal(backup.counts.images, 141);
  assert.equal(backup.counts.storageLinks, 141);
  await sql([{ sql: "UPDATE user_subjects SET note='批量改动' WHERE user_key=?", params: [owner] }]);
  const result = await api("/__test/site/restore", { backup, expectedCurrent: await snapshot() });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(businessContent(await snapshot()), businessContent(backup));
});

test("legacy JSON exports retain historical character tags, and merge import preserves unrelated records", async () => {
  const backup = await collection();
  const original = backup.subjects.find((subject) => subject.id === 10);
  assert.deepEqual(new Set(original.tags), new Set(["普通标签", "历史角色标签"]));
  const next = structuredClone(backup);
  next.subjects = [next.subjects.find((subject) => subject.id === 10)];
  next.subjects[0].note = "恢复后的备注";
  recountCollection(next);
  const preview = await api("/api/backup/import", { mode: "preview", backup: next });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.plan.update, 1);
  const imported = await api("/api/backup/import", { mode: "import", confirmed: true, backup: next });
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  assert.equal(imported.body.updated, 1);
  assert.ok(imported.body.preImportBackup);
  const after = await collection();
  assert.equal(after.subjects.length, 2);
  assert.equal(after.subjects.find((subject) => subject.id === 10).note, "恢复后的备注");
  assert.deepEqual(new Set(after.subjects.find((subject) => subject.id === 10).tags), new Set(original.tags));
});

test("legacy merge assigns fresh IDs and keeps each newly created gallery's images and storage links together", async () => {
  const backup = await collection();
  const gallery = backup.subjects.find((subject) => subject.id === 20);
  backup.subjects = [1, 2].map((index) => ({
    ...structuredClone(gallery), id: 0, subjectId: 7000 + index, title: `新画廊 ${index}`,
    images: [{ ...structuredClone(gallery.images[0]), thumbnail: `/api/media-assets?v=new_gallery_${index}` }],
    storageLinks: [{ ...structuredClone(gallery.storageLinks[0]), url: `https://example.com/share-${index}`, path: `/new-gallery/${index}` }],
  }));
  recountCollection(backup);
  const result = await api("/api/backup/import", { mode: "import", confirmed: true, backup });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.created, 2);
  assert.equal(result.body.updated, 0);
  const after = await collection();
  assert.equal(after.subjects.length, 4);
  const createdIds = [];
  for (const index of [1, 2]) {
    const row = after.subjects.find((subject) => subject.title === `新画廊 ${index}`);
    assert.ok(row.id > 0);
    createdIds.push(row.id);
    assert.deepEqual(row.images.map((image) => image.thumbnail), [`/api/media-assets?v=new_gallery_${index}`]);
    assert.deepEqual(row.storageLinks.map((link) => link.path), [`/new-gallery/${index}`]);
  }
  assert.equal(new Set(createdIds).size, 2);
});

test("legacy import rejects a stale preview revision and preserves the intervening edit", async () => {
  const backup = await collection();
  backup.subjects[0].note = "旧预览中的更改";
  const preview = await api("/api/backup/import", { mode: "preview", backup });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(typeof preview.body.revision, "string");
  await sql([{ sql: "UPDATE user_subjects SET note='预览后的新编辑' WHERE id=10 AND user_key=?", params: [owner] }]);
  const current = await snapshot();
  const result = await api("/api/backup/import", {
    mode: "import", confirmed: true, backup, expectedRevision: preview.body.revision,
  });
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.deepEqual(businessContent(await snapshot()), businessContent(current));
});

test("legacy import database failures return the pre-import snapshot and leave every collection row unchanged", async () => {
  const before = await snapshot();
  const original = await collection();
  const incoming = structuredClone(original);
  incoming.subjects[0].note = "should roll back";
  incoming.subjects.push({ ...structuredClone(incoming.subjects[0]), id: 0, subjectId: 7777, title: "Import should fail", images: [], storageLinks: [] });
  recountCollection(incoming);
  await sql(["CREATE TRIGGER fail_collection_backup_import BEFORE INSERT ON user_subjects WHEN NEW.title='Import should fail' BEGIN SELECT RAISE(ABORT,'injected collection import failure'); END"]);
  const result = await api("/api/backup/import", { mode: "import", confirmed: true, backup: incoming });
  assert.ok(result.status >= 400, JSON.stringify(result.body));
  assert.equal(result.body.rolledBack, true);
  assert.equal(result.body.created, 0);
  assert.equal(result.body.updated, 0);
  assert.equal(typeof result.body.error, "string");
  assert.deepEqual(businessContent(result.body.preImportBackup), businessContent(original));
  await sql(["DROP TRIGGER fail_collection_backup_import"]);
  assert.deepEqual(businessContent(await snapshot()), businessContent(before));
});

test("invalid legacy storage links fail validation without silently skipping them or changing any data", async () => {
  const before = await snapshot();
  const backup = await collection();
  backup.subjects[0].note = "must remain unchanged";
  backup.subjects.find((subject) => subject.storageLinks.length).storageLinks[0].url = "javascript:alert(1)";
  const result = await api("/api/backup/import", { mode: "import", confirmed: true, backup });
  assert.equal(result.status, 400, JSON.stringify(result.body));
  assert.deepEqual(businessContent(await snapshot()), businessContent(before));
});

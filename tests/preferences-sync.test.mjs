import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import wrangler from "wrangler";

const { unstable_splitSqlQuery: splitSqlQuery, unstable_dev } = wrangler;
let worker;
let cookie;
async function api(path, method = "GET", body) {
  const response = await worker.fetch(path, {
    method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}
async function setup(path, body) {
  const result = await api(path, "POST", body);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
}
const sql = (statements) => setup("/__test/sql", statements);
const query = (statement) => setup("/__test/query", { statement });

before(async () => {
  worker = await unstable_dev("tests/fixtures/preferences-sync-worker.mjs", {
    config: "tests/fixtures/preferences-sync-wrangler.jsonc", envFiles: ["tests/fixtures/.env.test"], persist: false, local: true, logLevel: "error",
    experimental: { disableExperimentalWarning: true, disableDevRegistry: true, showInteractiveDevSession: false, testMode: true, watch: false },
  });
  for (const name of (await readdir("drizzle")).filter((name) => name.endsWith(".sql")).sort()) {
    await sql(splitSqlQuery(await readFile(`drizzle/${name}`, "utf8")));
  }
  const response = await worker.fetch("/__test/setup", { method: "POST" });
  assert.equal(response.status, 200, await response.text());
  cookie = response.headers.get("set-cookie").split(";")[0];
});
after(async () => { await worker?.stop(); });

test("empty and unknown-only preference requests do not create a default row", async () => {
  assert.equal((await api("/api/state")).body.state, null);
  await setup("/api/state", {});
  await setup("/api/state", { anime: [{ title: "must not be stored" }], userKey: "other" });
  assert.equal((await api("/api/state")).body.state, null);
});

test("first partial preference write initializes defaults and rejects invalid bodies", async () => {
  for (const body of [null, [], "invalid"]) assert.equal((await api("/api/state", "POST", body)).status, 400);
  await setup("/api/state", { font: "serif" });
  const { state } = (await api("/api/state")).body;
  assert.equal(state.font, "serif");
  assert.equal(state.primaryColor, "#66CCFF");
  assert.deepEqual(state.collections, []);
});

test("partial and concurrent preference edits preserve unrelated configuration and media", async () => {
  const original = {
    collections: ["收藏夹"], bangumiSyncTypes: ["light_novel"], mediaOrder: ["music", "anime"],
    deviceSubCategories: { audio: ["耳机"] }, deviceCategoryLabels: { audio: "音频" },
    avatarImage: "/api/avatar?v=original", font: "serif", softness: 60, backgroundVersion: 2,
    primaryColor: "#112233", accentColor: "#445566", titleMode: "jp",
    syncSettings: { bangumi: { cover: false, title: true, overview: false, score: false }, vndb: { cover: true, title: false, overview: true, score: false } },
  };
  await setup("/api/state", original);
  await sql(["UPDATE user_state SET anime_json='legacy-media-do-not-touch' WHERE user_key='preferences-sync-test-owner'"]);
  const responses = await Promise.all([
    api("/api/state", "POST", { font: "round" }),
    api("/api/state", "POST", { accentColor: "#aabbcc" }),
  ]);
  for (const result of responses) assert.equal(result.status, 200);
  const { state } = (await api("/api/state")).body;
  for (const [key, value] of Object.entries(original)) {
    assert.deepEqual(state[key], key === "font" ? "round" : key === "accentColor" ? "#AABBCC" : value, key);
  }
  assert.equal((await query("SELECT anime_json FROM user_state"))[0].anime_json, "legacy-media-do-not-touch");
  await setup("/api/state", { collections: [], avatarImage: "" });
  const cleared = (await api("/api/state")).body.state;
  assert.deepEqual(cleared.collections, []);
  assert.equal(cleared.avatarImage, "");
  assert.equal(cleared.font, "round");
});

const remoteCollections = () => [
  { subject_id: 101, subject_type: 1, type: 3, vol_status: 2, ep_status: 99, subject: { id: 101, name: "Book", volumes: 20, eps: 99, tags: [{ name: "小说" }] } },
  { subject_id: 102, subject_type: 1, type: 3, vol_status: 3, ep_status: 1, subject: { id: 102, name: "Manga", volumes: 12, eps: 100, tags: [{ name: "漫画" }] } },
  { subject_id: 103, subject_type: 3, type: 3, vol_status: 2, ep_status: 9, subject: { id: 103, name: "Music", volumes: 5, tags: [] } },
];

test("Bangumi book progress survives push/pull using volumes while manga and music keep their mapping", async () => {
  await setup("/__test/upstream", remoteCollections());
  await sql([
    "INSERT INTO user_subjects (id,user_key,type,subject_id,title,source,progress,total,updated_at) VALUES (101,'preferences-sync-test-owner','light_novel',101,'Manual book','bangumi',7,20,1),(102,'preferences-sync-test-owner','manga',102,'Manga','bangumi',15,100,1),(103,'preferences-sync-test-owner','music',103,'Music','bangumi',2,5,1)",
  ]);
  const pushed = await setup("/api/bangumi/account/sync", { direction: "push", types: ["light_novel", "manga", "music"] });
  assert.equal(pushed.synced, 3);
  assert.equal(pushed.failed, 0);
  const writes = (await api("/__test/writes")).body;
  assert.equal(writes.find((item) => item.subjectId === 101).body.vol_status, 7);
  assert.equal(writes.find((item) => item.subjectId === 101).body.ep_status, undefined);
  assert.equal(writes.find((item) => item.subjectId === 102).body.ep_status, 15);
  assert.equal(writes.find((item) => item.subjectId === 102).body.vol_status, undefined);
  assert.equal(writes.find((item) => item.subjectId === 103).body.vol_status, undefined, "music must not gain a new writeback behavior");
  await sql(["UPDATE user_subjects SET progress=0"]);
  const pulled = await setup("/api/bangumi/account/sync", { direction: "pull", types: ["light_novel", "manga", "music"] });
  assert.equal(pulled.synced, 3);
  assert.equal(pulled.failed, 0);
  assert.deepEqual(await query("SELECT id,progress,title FROM user_subjects ORDER BY id"), [
    { id: 101, progress: 7, title: "Manual book" }, { id: 102, progress: 15, title: "Manga" }, { id: 103, progress: 2, title: "Music" },
  ]);
});

test("invalid book volume progress is not replaced by an unrelated chapter count", async () => {
  const collections = remoteCollections();
  collections[0].vol_status = -1;
  await setup("/__test/upstream", collections);
  await setup("/api/bangumi/account/sync", { direction: "pull", types: ["light_novel"] });
  assert.equal((await query("SELECT progress FROM user_subjects WHERE id=101"))[0].progress, 0);
  assert.equal((await query("SELECT progress FROM user_subjects WHERE id=102"))[0].progress, 15);
});

test("a newly imported book uses volumes for both progress and total", async () => {
  await setup("/__test/upstream", [{
    subject_id: 104, subject_type: 1, type: 3, vol_status: 7, ep_status: 99,
    subject: { id: 104, name: "New book", volumes: 20, eps: 100, tags: [{ name: "小说" }] },
  }]);
  const pulled = await setup("/api/bangumi/account/sync", { direction: "pull", types: ["light_novel"] });
  assert.equal(pulled.synced, 1);
  assert.equal(pulled.failed, 0);
  assert.deepEqual(await query("SELECT type,progress,total FROM user_subjects WHERE subject_id=104"), [
    { type: "light_novel", progress: 7, total: 20 },
  ]);
});

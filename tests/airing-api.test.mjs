import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import wrangler from "wrangler";

const { unstable_splitSqlQuery: splitSqlQuery, unstable_dev } = wrangler;
let worker;
async function setup(path, body) {
  const response = await worker.fetch(path, { method: "POST", body: JSON.stringify(body) });
  assert.equal(response.status, 200, await response.text());
}
async function api(path = "/api/agent/anime/airing?source=animeschedule", token = "test-nova-token") {
  const response = await worker.fetch(path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const text = await response.text();
  assert.ok(!text.includes("isolated-animeschedule-token"), "Responses must not contain the credential");
  return { status: response.status, body: JSON.parse(text), cacheControl: response.headers.get("cache-control") };
}
before(async () => {
  worker = await unstable_dev("tests/fixtures/airing-worker.mjs", {
    config: "tests/fixtures/airing-wrangler.jsonc", persist: false, local: true, logLevel: "error",
    experimental: { disableExperimentalWarning: true, disableDevRegistry: true, showInteractiveDevSession: false, testMode: true, watch: false },
  });
  for (const name of (await readdir("drizzle")).filter((name) => name.endsWith(".sql")).sort()) {
    await setup("/__test/sql", splitSqlQuery(await readFile(`drizzle/${name}`, "utf8")));
  }
  await setup("/__test/sql", ["INSERT INTO admin_account (id,username,password_hash,created_at,updated_at) VALUES (1,'test','test',1,1)"]);
});
after(async () => { await worker?.stop(); });

test("airing authenticates both Agents and advertises the read capability", async () => {
  await setup("/__test/upstream", { status: 200, body: [] });
  assert.equal((await api(undefined, "")).status, 401);
  assert.equal((await api(undefined, "invalid-token")).status, 401);
  assert.equal(await (await worker.fetch("/__test/observed")).json(), null);
  for (const token of ["test-nova-token", "test-hikari-token"]) {
    const result = await api("/api/agent", token);
    assert.ok(result.body.permissions.includes("airing:read"));
    assert.equal(result.body.endpoints.animeAiring, "/api/agent/anime/airing");
  }
});

test("airing decrypts the stored credential only in the Worker and returns schedule fields", async () => {
  await setup("/__test/credential", { enabled: true });
  const row = { id: "schedule-1", route: "anime-1", title: "Anime 1", episodeDate: "2026-10-02T15:00:00Z", episodeNumber: 3, token: "isolated-animeschedule-token", tokenCiphertext: "private-ciphertext", headers: { authorization: "private" } };
  await setup("/__test/upstream", { status: 200, body: [row] });
  for (const token of ["test-nova-token", "test-hikari-token"]) {
    const result = await api("/api/agent/anime/airing?source=animeschedule&tz=Asia%2FHong_Kong&week=40&year=2026", token);
    assert.equal(result.status, 200);
    assert.equal(result.cacheControl, "no-store");
    assert.equal(result.body.source, "animeschedule");
    assert.equal(result.body.credentialSource, "settings");
    assert.deepEqual(result.body.items, [{ id: row.id, route: row.route, title: row.title, episodeDate: row.episodeDate, episodeNumber: row.episodeNumber }]);
    const observed = await (await worker.fetch("/__test/observed")).json();
    assert.equal(observed.authenticated, true);
    assert.equal(observed.redirect, "manual");
    assert.equal(new URL(observed.url).searchParams.get("week"), "40");
  }
});

test("airing refuses unsupported sources, arbitrary proxy targets and malformed queries", async () => {
  await setup("/__test/upstream", { status: 200, body: [] });
  for (const query of ["source=other", "url=https://example.com", "tz=invalid", "week=54&year=2026", "week=40", "year=2026", "week=40&year=abc", "source=animeschedule&source=animeschedule"]) {
    assert.equal((await api(`/api/agent/anime/airing?${query}`)).status, 400, query);
  }
  assert.equal(await (await worker.fetch("/__test/observed")).json(), null);
});

test("airing reports missing credentials without requesting the upstream", async () => {
  await setup("/__test/credential", { enabled: false });
  await setup("/__test/upstream", { status: 200, body: [] });
  const result = await api();
  assert.equal(result.status, 503);
  assert.match(result.body.error, /未配置/);
  assert.equal(await (await worker.fetch("/__test/observed")).json(), null);
});

test("airing never forwards upstream error bodies or exception messages", async () => {
  await setup("/__test/credential", { enabled: true });
  for (const response of [
    { status: 401, body: { error: "isolated-animeschedule-token" } },
    { status: 302, body: { error: "isolated-animeschedule-token" } },
    { status: 500, body: { error: "isolated-animeschedule-token" } },
    { status: 200, body: { unexpected: "isolated-animeschedule-token" } },
    { reject: true },
  ]) {
    await setup("/__test/upstream", response);
    assert.equal((await api()).status, 502);
  }
});

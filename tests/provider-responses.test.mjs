import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

// These adapters only import erased types. Compile their actual source so the
// offline tests can exercise parameter-property classes on the supported Node 22.
async function adapter(name) {
  const source = await readFile(new URL(`../app/lib/${name}.ts`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}

const mangaDex = await adapter("mangadex-api");
const aniList = await adapter("anilist-api");
const adapters = [
  { name: "MangaDex", search: () => mangaDex.searchMangaDex("test"), ErrorType: mangaDex.MangaDexApiError,
    empty: { data: [] }, result: { data: [{ id: "manga-id", attributes: { title: { en: "Test" } } }] },
    invalid: [{}, { data: null }, { data: {} }], host: "api.mangadex.org" },
  { name: "AniList", search: () => aniList.searchAniList("test", "MANGA"), ErrorType: aniList.AniListApiError,
    empty: { data: { Page: { media: [] } } }, result: { data: { Page: { media: [{ id: 1, title: { native: "Test" } }] } } },
    invalid: [{}, { data: null }, { data: {} }, { data: { Page: { media: {} } } }], host: "graphql.anilist.co" },
];

for (const provider of adapters) {
  test(`${provider.name} distinguishes malformed success responses from empty search results`, async (t) => {
    let body;
    t.mock.method(globalThis, "fetch", async (url, init) => {
      assert.equal(new URL(url).hostname, provider.host);
      assert.ok(init.signal instanceof AbortSignal);
      return new Response(body);
    });
    for (body of ["<html>upstream unavailable</html>", "null", "[]", ...provider.invalid.map((value) => JSON.stringify(value))]) {
      await assert.rejects(provider.search, (error) => error instanceof provider.ErrorType && error.status === 502);
    }
    body = JSON.stringify(provider.empty);
    assert.deepEqual(await provider.search(), []);
    body = JSON.stringify(provider.result);
    assert.equal((await provider.search()).length, 1);
  });

  test(`${provider.name} preserves upstream HTTP errors even when their body is not JSON`, async (t) => {
    let status;
    t.mock.method(globalThis, "fetch", async () => new Response("upstream unavailable", { status }));
    for (status of [404, 429, 503]) {
      await assert.rejects(provider.search, (error) => error instanceof provider.ErrorType && error.status === status);
    }
  });
}

test("AniList GraphQL failures remain service errors, while a missing media result remains 404", async (t) => {
  let payload = { errors: [{ message: "Service temporarily unavailable" }] };
  t.mock.method(globalThis, "fetch", async () => Response.json(payload));
  await assert.rejects(() => aniList.getAniListMedia(1), (error) => error instanceof aniList.AniListApiError && error.status === 502);
  payload = { data: { Media: null } };
  await assert.rejects(() => aniList.getAniListMedia(1), (error) => error instanceof aniList.AniListApiError && error.status === 404);
  payload = { data: { Media: { id: 1 } } };
  assert.equal((await aniList.getAniListMedia(1)).id, 1);
});

// Exercise the real aggregation function with isolated provider outcomes. No
// external services or Cloudflare bindings are involved in this empty-result case.
async function aggregation(failedSearch) {
  const source = await readFile(new URL("../app/lib/media-provider.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  const isolated = outputText.replace(/import \{([^}]+)\} from "[^\"]+";/g, (_line, names) => {
    const functions = names.split(",").map((name) => name.trim()).map((name) =>
      `export function ${name}() { ${name === failedSearch ? 'return Promise.reject(new Error("upstream unavailable"));' : "return [];"} }`).join("\n");
    const url = `data:text/javascript;base64,${Buffer.from(functions).toString("base64")}`;
    return `import {${names}} from "${url}";`;
  });
  return import(`data:text/javascript;base64,${Buffer.from(isolated).toString("base64")}`);
}

test("manga and book searches return an empty result when every provider succeeds with no matches", async () => {
  const provider = await aggregation();
  for (const type of ["manga", "light_novel"]) assert.deepEqual(await provider.searchMedia("no matches", type), []);
});

test("empty searches still report provider failures when a catalog could not be queried", async () => {
  const provider = await aggregation("searchAniList");
  for (const type of ["manga", "light_novel"]) {
    await assert.rejects(() => provider.searchMedia("no matches", type), /upstream unavailable/);
  }
});

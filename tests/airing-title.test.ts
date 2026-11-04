import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error Node's TypeScript loader requires an explicit extension.
import { airingTitleKey } from "../app/lib/airing-title-key.ts";
// @ts-expect-error Node's TypeScript loader requires an explicit extension.
import { parseAniListAiring, parseAnimeScheduleTimetable } from "../app/lib/anime-airing.ts";

test("season spellings canonicalise to the same merge key", () => {
  const blackClover = airingTitleKey("ブラッククローバー 第2期");
  assert.equal(blackClover, airingTitleKey("ブラッククローバー 2nd Season"));
  assert.equal(blackClover, airingTitleKey("ブラッククローバー Season 2"));
  assert.equal(airingTitleKey("Black Clover 2nd Season"), airingTitleKey("Black Clover Season 2"));
  assert.equal(airingTitleKey("黑色五叶草 第二季"), airingTitleKey("黑色五叶草 第2季"));
  assert.equal(airingTitleKey("黑色五叶草 第二季"), airingTitleKey("黑色五叶草 Season 2"));
});

test("different seasons never share a merge key", () => {
  assert.notEqual(airingTitleKey("某番 第1期"), airingTitleKey("某番 第2期"));
  assert.notEqual(airingTitleKey("某番 1st Season"), airingTitleKey("某番 2nd Season"));
  assert.notEqual(airingTitleKey("某番 第一季"), airingTitleKey("某番 第二季"));
  assert.notEqual(airingTitleKey("葬送的芙莉莲"), airingTitleKey("黑色五叶草 第二季"));
});

test("plain titles keep the old stripping behaviour", () => {
  assert.equal(airingTitleKey("葬送的芙莉莲"), "葬送的芙莉莲");
  assert.equal(airingTitleKey("Black Clover"), "blackclover");
  assert.equal(airingTitleKey(""), "");
});

test("AniList airing rows prefer the native title over English", () => {
  const future = Math.floor(Date.now() / 1000) + 86400;
  const rows = parseAniListAiring(
    {
      data: {
        Page: {
          media: [
            {
              id: 195604,
              title: {
                romaji: "Black Clover 2nd Season",
                english: "Black Clover Season 2",
                native: "ブラッククローバー 第2期",
                userPreferred: "Black Clover 2nd Season",
              },
              episodes: 13,
              coverImage: { large: "" },
              airingSchedule: { nodes: [{ airingAt: future, episode: 6 }] },
            },
          ],
        },
      },
    },
    "fall",
    2026,
    new Date(),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "ブラッククローバー 第2期");
  assert.equal(rows[0].jpTitle, "ブラッククローバー 第2期");
  assert.equal(rows[0].nextEpisode, 6);
});

test("AnimeSchedule airing rows prefer the native title over English", () => {
  const future = new Date(Date.now() + 86400 * 1000).toISOString();
  const rows = parseAnimeScheduleTimetable(
    [
      {
        id: "black-clover-2",
        route: "black-clover-2",
        title: "Black Clover 2nd Season",
        english: "Black Clover Season 2",
        romaji: "Black Clover 2nd Season",
        native: "ブラッククローバー 第2期",
        episodeDate: future,
        episodeNumber: 6,
      },
    ],
    "fall",
    2026,
    new Date(),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "ブラッククローバー 第2期");
  assert.equal(rows[0].jpTitle, "ブラッククローバー 第2期");
  assert.equal(rows[0].nextEpisode, 6);
});

test("Chinese native titles are used for Chinese works", () => {
  const future = Math.floor(Date.now() / 1000) + 86400;
  const rows = parseAniListAiring(
    {
      data: {
        Page: {
          media: [
            {
              id: 999001,
              title: {
                romaji: "Some Chinese Show",
                english: "Some Chinese Show English Title",
                native: "某中国动画",
                userPreferred: "Some Chinese Show",
              },
              episodes: 12,
              coverImage: { large: "" },
              airingSchedule: { nodes: [{ airingAt: future, episode: 3 }] },
            },
          ],
        },
      },
    },
    "fall",
    2026,
    new Date(),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "某中国动画");
  assert.equal(rows[0].jpTitle, "某中国动画");
});

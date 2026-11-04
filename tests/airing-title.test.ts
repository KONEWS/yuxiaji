import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error Node's TypeScript loader requires an explicit extension.
import { airingTitleKey } from "../app/lib/airing-title-key.ts";

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

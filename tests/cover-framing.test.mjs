import assert from "node:assert/strict";
import { test } from "node:test";
import { coverLayout, moveCover } from "../app/lib/cover-framing.ts";

const size = { frameWidth: 200, frameHeight: 300, imageWidth: 800, imageHeight: 300 };
const center = { x: 0, y: 0 };

test("zooming out reveals the original panorama", () => {
  const small = coverLayout(size, "cover", { coverZoom: 25 });
  assert.equal(small.width, 200);
  assert.equal(small.height, 75);
  assert.equal(small.centerX, 0);
});

test("a drag moves the image the same distance even at its default zoom", () => {
  const next = moveCover(size, "cover", {}, 100, center, { x: 80, y: -30 });
  const displayed = coverLayout(size, "cover", next);
  assert.equal(displayed.centerX, 80);
  assert.equal(displayed.centerY, -30);
});

test("starting a gesture preserves legacy off-center framing", () => {
  for (const fit of ["cover", "contain"]) {
    const legacy = { coverPositionX: 25, coverPositionY: 83, coverZoom: 180 };
    const before = coverLayout(size, fit, legacy);
    const after = coverLayout(size, fit, moveCover(size, fit, legacy, 180, center, center));
    assert.ok(Math.abs(before.centerX - after.centerX) < 0.1);
    assert.ok(Math.abs(before.centerY - after.centerY) < 0.1);
  }
});

test("pinching carries the grabbed image point to the new midpoint at the zoom limit", () => {
  const next = moveCover(size, "cover", { coverZoom: 250 }, 650, { x: 40, y: 20 }, { x: 65, y: 50 });
  assert.equal(next.coverZoom, 500);
  const result = coverLayout(size, "cover", next);
  assert.ok(Math.abs(result.centerX + 40 * 2 - 65) < 0.21);
  assert.ok(Math.abs(result.centerY + 20 * 2 - 50) < 0.08);
});

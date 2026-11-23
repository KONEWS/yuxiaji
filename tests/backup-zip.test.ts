import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error Node's TypeScript loader requires a source extension.
import { backupCrc32, createBackupZip, inspectBackupZip, readBackupZipEntry } from "../app/lib/backup-zip.ts";
const encoder = new TextEncoder();
function stream(bytes: Uint8Array, width = 2) {
  let offset = 0;
  return new ReadableStream<Uint8Array>({ pull(controller) { if (offset >= bytes.length) controller.close(); else { controller.enqueue(bytes.slice(offset, offset + width)); offset += width; } } });
}
async function zip() {
  const json = encoder.encode('{"hello":"月下集"}'); const image = encoder.encode("hello image");
  const blob = await new Response(createBackupZip([
    { name: "backup.json", size: json.length, stream: stream(json) },
    { name: "assets/" + "a".repeat(64), size: image.length, stream: stream(image, 1) },
  ])).blob();
  return { blob, json, image };
}
test("ZIP streams preserve bytes across one-byte chunks and CRC is standard CRC-32", async () => {
  assert.equal(backupCrc32(encoder.encode("123456789")), 0xcbf43926);
  const { blob, json, image } = await zip(); const entries = await inspectBackupZip(blob);
  assert.equal(entries.length, 2);
  assert.deepEqual(new Uint8Array(await (await readBackupZipEntry(blob, entries[0])).arrayBuffer()), json);
  assert.deepEqual(new Uint8Array(await (await readBackupZipEntry(blob, entries[1])).arrayBuffer()), image);
});
test("corrupted image payload fails CRC before upload", async () => {
  const { blob } = await zip(); const entries = await inspectBackupZip(blob); const bytes = new Uint8Array(await blob.arrayBuffer());
  bytes[entries[1].dataOffset] ^= 1;
  await assert.rejects(readBackupZipEntry(new Blob([bytes]), entries[1]), /校验失败/);
});
test("truncation and compressed ZIP entries are rejected", async () => {
  const { blob } = await zip(); await assert.rejects(inspectBackupZip(blob.slice(0, blob.size - 1)), /ZIP/);
  const bytes = new Uint8Array(await blob.arrayBuffer()); const view = new DataView(bytes.buffer);
  const directory = view.getUint32(bytes.length - 6, true); view.setUint16(directory + 10, 8, true);
  await assert.rejects(inspectBackupZip(new Blob([bytes])), /未加密/);
});
test("ZIP writer fails on path traversal, duplicate names and wrong sizes", async () => {
  const data = encoder.encode("{}");
  const invalid = [
    [{ name: "../backup.json", size: 2, stream: stream(data) }],
    [{ name: "backup.json", size: 2, stream: stream(data) }, { name: "backup.json", size: 2, stream: stream(data) }],
    [{ name: "backup.json", size: 3, stream: stream(data) }],
  ];
  for (const entries of invalid) await assert.rejects(new Response(createBackupZip(entries)).arrayBuffer());
});
test("ZIP central directory cannot point two files at an overlapping local entry", async () => {
  const { blob } = await zip(); const bytes = new Uint8Array(await blob.arrayBuffer()); const view = new DataView(bytes.buffer);
  const directory = view.getUint32(bytes.length - 6, true);
  const second = directory + 46 + view.getUint16(directory + 28, true);
  view.setUint32(second + 42, 0, true);
  await assert.rejects(inspectBackupZip(new Blob([bytes])), /重叠/);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { chatGPTFileUrl, boundedImageBytes, downloadCoverImage, transformCoverImage, coverImageType } from "../app/lib/mcp-file-image.ts";

const png = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
const webp = new Uint8Array([0x52,0x49,0x46,0x46,12,0,0,0,0x57,0x45,0x42,0x50,0x56,0x50,0x38,0x20]);

test("ChatGPT file allowlist rejects alternate schemes, embedded credentials, lookalikes and private hosts", () => {
  for (const value of ["file:///cover.png", "http://files.oaiusercontent.com/image", "https://127.0.0.1/image", "https://files.oaiusercontent.com.evil.invalid/image", "https://evilfiles.oaiusercontent.com/image", "https://files.oaiusercontent.com@evil.invalid/image", "https://files.oaiusercontent.com:8443/image", "https://files.oaiusercontent.com/image#fragment"]) assert.throws(() => chatGPTFileUrl(value));
  assert.equal(chatGPTFileUrl("https://files.oaiusercontent.com/cover.png?temporary=secret").hostname, "files.oaiusercontent.com");
});

test("image reader enforces declared and streamed byte limits, rejects empty responses", async () => {
  await assert.rejects(boundedImageBytes(new Response(png, { headers: { "content-length": "9999" } }), 100));
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(101)); }, cancel() { cancelled = true; } });
  await assert.rejects(boundedImageBytes(new Response(stream), 100));
  assert.equal(cancelled, true);
  await assert.rejects(boundedImageBytes(new Response(new Uint8Array()), 100));
  assert.deepEqual(await boundedImageBytes(new Response(png), 100), png);
});

test("native file download disables redirects and checks real MIME independently of filenames", async () => {
  const url = chatGPTFileUrl("https://files.oaiusercontent.com/image");
  const result = await downloadCoverImage(url, "image/png", async (input, init) => {
    assert.equal(String(input), String(url));
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
    return new Response(png, { headers: { "content-type": "image/png" } });
  });
  assert.equal(result.type, "image/png");
  await assert.rejects(downloadCoverImage(url, "image/jpeg", async () => new Response(png)));
  await assert.rejects(downloadCoverImage(url, undefined, async () => new Response("<html>not a cover</html>")));
  await assert.rejects(downloadCoverImage(url, undefined, async () => new Response(png, { status: 302, headers: { location: "http://127.0.0.1" } })));
});

test("cover conversion uses the Images MIME output contract and never stores input originals", async () => {
  let source;
  const images = { input(stream) { source = stream; return { transform(options) {
    assert.deepEqual(options, { width: 1600, fit: "scale-down" });
    return { async output(options) {
      assert.deepEqual(options, { format: "image/webp", quality: 82 });
      return { response: () => new Response(webp) };
    } };
  } }; } };
  const output = await transformCoverImage(png, images);
  assert.equal(coverImageType(output), "image/webp");
  assert.deepEqual(new Uint8Array(await new Response(source).arrayBuffer()), png);
  assert.notDeepEqual(output, png);
  await assert.rejects(transformCoverImage(png, { input: () => ({ transform: () => ({ output: async () => ({ response: () => new Response(png) }) }) }) }));
});

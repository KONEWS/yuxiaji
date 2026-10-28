import { hashPassword, createSession } from "../../app/lib/admin-auth.ts";
import { handleMcpOAuth } from "../../app/lib/mcp-oauth.ts";
import { handleMcpRequest } from "../../app/lib/mcp-server.ts";
import * as media from "../../app/api/agent/media/route.ts";
import * as devices from "../../app/api/agent/devices/route.ts";
import { uploadMusicCover } from "../../app/lib/mcp-music-cover.ts";
import { transformCoverImage } from "../../app/lib/mcp-file-image.ts";
import * as assets from "../../app/api/media-assets/route.ts";
import { uploadGalleryImage } from "../../app/api/agent/gallery/upload/route.ts";
import * as twoFactor from "../../app/api/auth/2fa/route.ts";

// This entrypoint and its setup endpoints only run in a nonpersistent local
// test Worker. They are never imported by the production Worker.
const fixtureImage = new Uint8Array([0x52,0x49,0x46,0x46,12,0,0,0,0x57,0x45,0x42,0x50,0x56,0x50,0x38,0x20]);
let imageDownloads = 0;
let imageTransforms = 0;
globalThis.fetch = async (input, init) => {
  const url = new URL(input);
  if (url.origin !== "https://files.oaiusercontent.com" || init?.redirect !== "manual") throw new Error("Network access is disabled in the isolated MCP fixture");
  imageDownloads++;
  if (url.pathname === "/unavailable.webp") return new Response("unavailable", { status: 503 });
  if (url.pathname === "/fixture.webp" || url.pathname === "/different.webp") return new Response(url.pathname === "/different.webp" ? new Uint8Array([...fixtureImage, 1]) : fixtureImage, { headers: { "content-type": "image/webp" } });
  if (url.pathname === "/oversize.webp") return new Response(fixtureImage, { headers: { "content-length": String(21*1024*1024) } });
  return new Response("not an image", { headers: { "content-type": "text/html" } });
};
const fixtureImages = { input: () => ({ transform: (options) => ({ output: async (output) => {
  imageTransforms++;
  if (options.width !== 1600 || options.fit !== "scale-down" || output.format !== "image/webp" || output.quality !== 82) throw new Error("Invalid transform contract");
  return { response: () => new Response(fixtureImage) };
} }) }) };

const worker = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/__test/image-downloads") return Response.json({ count: imageDownloads, transforms: imageTransforms });
    if (url.pathname === "/__test/assets") return Response.json((await env.BUCKET.list()).objects.map(({ key }) => key));
    if (url.pathname === "/__test/delete-asset") {
      const { key } = await request.json();
      await env.BUCKET.delete(key);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/__test/sql") {
      const statements = await request.json();
      await env.DB.batch(statements.map((statement) => env.DB.prepare(statement)));
      return Response.json({ ok: true });
    }
    if (url.pathname === "/__test/query") {
      const { statement, params = [] } = await request.json();
      return Response.json((await env.DB.prepare(statement).bind(...params).all()).results);
    }
    if (url.pathname === "/__test/setup") {
      const now = Date.now();
      await env.DB.prepare("INSERT INTO admin_account (id,username,password_hash,created_at,updated_at) VALUES (1,?,?,?,?)")
        .bind("mcp-test-admin", await hashPassword("fixture-only-admin-password"), now, now).run();
      const { cookie } = await createSession(request, 1, 86400);
      return Response.json({ origin: url.origin }, { headers: { "set-cookie": cookie } });
    }
    if (url.pathname === "/__test/session") {
      const { cookie } = await createSession(request, 1, 86400, url.searchParams.get("pending") === "1");
      return Response.json({ ok: true }, { headers: { "set-cookie": cookie } });
    }
    if (url.pathname === "/api/auth/2fa" && request.method === "POST") return twoFactor.POST(request);
    if (url.pathname === "/__test/2fa-concurrent") {
      // Start real handlers together: separate local HTTP fetches may be
      // serialized by the test proxy and miss the challenge-consumption race.
      const responses = await Promise.all(Array.from({ length: 3 }, () => twoFactor.POST(request.clone())));
      return Response.json(responses.map((response) => response.status));
    }
    const oauth = await handleMcpOAuth(request);
    if (oauth) return oauth;
    if (url.pathname === "/mcp") return handleMcpRequest(request, { musicCoverUploader: (req) => uploadMusicCover(req, (bytes) => transformCoverImage(bytes, fixtureImages)) });
    if (url.pathname === "/api/agent/gallery/upload") return uploadGalleryImage(request, fixtureImages);
    const routes = { "/api/agent/media": media, "/api/agent/devices": devices, "/api/media-assets": assets };
    return routes[url.pathname]?.[request.method]?.(request) ?? new Response("Not found", { status: 404 });
  },
};
export default worker;

import { hashPassword, createSession } from "../../app/lib/admin-auth.ts";
import { handleMcpOAuth } from "../../app/lib/mcp-oauth.ts";
import { handleMcpRequest } from "../../app/lib/mcp-server.ts";
import * as media from "../../app/api/agent/media/route.ts";
import * as devices from "../../app/api/agent/devices/route.ts";
import { uploadMusicCover } from "../../app/lib/mcp-music-cover.ts";
import { transformCoverImage } from "../../app/lib/mcp-file-image.ts";
import * as assets from "../../app/api/media-assets/route.ts";

// This entrypoint and its setup endpoints only run in a nonpersistent local
// test Worker. They are never imported by the production Worker.
const fixtureImage = new Uint8Array([0x52,0x49,0x46,0x46,12,0,0,0,0x57,0x45,0x42,0x50,0x56,0x50,0x38,0x20]);
let imageDownloads = 0;
globalThis.fetch = async (input, init) => {
  const url = new URL(input);
  if (url.origin !== "https://files.oaiusercontent.com" || init?.redirect !== "manual") throw new Error("Network access is disabled in the isolated MCP fixture");
  imageDownloads++;
  if (url.pathname === "/unavailable.webp") return new Response("unavailable", { status: 503 });
  if (url.pathname === "/fixture.webp") return new Response(fixtureImage, { headers: { "content-type": "image/webp" } });
  if (url.pathname === "/oversize.webp") return new Response(fixtureImage, { headers: { "content-length": String(21*1024*1024) } });
  return new Response("not an image", { headers: { "content-type": "text/html" } });
};
const fixtureImages = { input: () => ({ transform: (options) => ({ output: async (output) => {
  if (options.width !== 1600 || options.fit !== "scale-down" || output.format !== "image/webp" || output.quality !== 82) throw new Error("Invalid transform contract");
  return { response: () => new Response(fixtureImage) };
} }) }) };

const worker = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/__test/image-downloads") return Response.json({ count: imageDownloads });
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
      const { cookie } = await createSession(request, 1, 86400);
      return Response.json({ ok: true }, { headers: { "set-cookie": cookie } });
    }
    const oauth = await handleMcpOAuth(request);
    if (oauth) return oauth;
    if (url.pathname === "/mcp") return handleMcpRequest(request, { musicCoverUploader: (req) => uploadMusicCover(req, (bytes) => transformCoverImage(bytes, fixtureImages)) });
    const routes = { "/api/agent/media": media, "/api/agent/devices": devices, "/api/media-assets": assets };
    return routes[url.pathname]?.[request.method]?.(request) ?? new Response("Not found", { status: 404 });
  },
};
export default worker;

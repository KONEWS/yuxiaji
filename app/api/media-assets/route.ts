import { env } from "cloudflare:workers";
import { getCurrentUser } from "../../lib/current-user";

const allowed = new Set(["image/jpeg", "image/png", "image/webp"]);

async function keyFor(email: string, version: number) {
  const bytes = new TextEncoder().encode(email);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest)).map((item) => item.toString(16).padStart(2, "0")).join("");
  return `media-assets/${hash}/gallery/${version}`;
}

export async function GET(request: Request) {
  const email = getCurrentUser();
  const version = Number(new URL(request.url).searchParams.get("v"));
  if (!Number.isFinite(version) || version <= 0) return new Response("Not found", { status: 404 });
  const object = await env.BUCKET.get(await keyFor(email, version));
  if (!object) return new Response("Not found", { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "private, max-age=31536000, immutable");
  return new Response(object.body, { headers });
}

/** Accepts only the browser-generated thumbnail, never the original selected file. */
export async function POST(request: Request) {
  const email = getCurrentUser();
  try {
    const form = await request.formData();
    const file = form.get("image");
    if (!(file instanceof File)) return Response.json({ error: "请选择图片文件" }, { status: 400 });
    if (!allowed.has(file.type)) return Response.json({ error: "缩略图必须是 JPG、PNG 或 WebP" }, { status: 415 });
    if (file.size > 5 * 1024 * 1024) return Response.json({ error: "缩略图不能超过 5 MB" }, { status: 413 });
    const version = Date.now();
    await env.BUCKET.put(await keyFor(email, version), file.stream(), { httpMetadata: { contentType: file.type } });
    return Response.json({ ok: true, url: `/api/media-assets?v=${version}` });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "上传失败" }, { status: 500 });
  }
}

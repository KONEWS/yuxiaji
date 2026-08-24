import { env } from "cloudflare:workers";
import { getCurrentUser } from "../../lib/current-user";

const allowed = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

async function keyFor(email: string) {
  const bytes = new TextEncoder().encode(email);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return "avatars/" + Array.from(new Uint8Array(digest)).map((item) => item.toString(16).padStart(2, "0")).join("");
}

export async function GET() {
  const email = getCurrentUser();
  const object = await env.BUCKET.get(await keyFor(email));
  if (!object) return new Response("Not found", { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "private, max-age=3600");
  return new Response(object.body, { headers });
}

export async function POST(request: Request) {
  const email = getCurrentUser();
  const form = await request.formData();
  const file = form.get("avatar");
  if (!(file instanceof File)) return Response.json({ error: "请选择头像图片" }, { status: 400 });
  if (!allowed.has(file.type)) return Response.json({ error: "仅支持 JPG、PNG、WebP 或 GIF" }, { status: 415 });
  if (file.size > 8 * 1024 * 1024) return Response.json({ error: "图片不能超过 8 MB" }, { status: 413 });
  await env.BUCKET.put(await keyFor(email), file.stream(), { httpMetadata: { contentType: file.type } });
  return Response.json({ ok: true, url: `/api/avatar?v=${Date.now()}` });
}

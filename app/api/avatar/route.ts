import { env } from "cloudflare:workers";
import { getCurrentUser } from "../../lib/current-user";
import { guardBrowserApi } from "../../lib/admin-auth";

const allowed = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
function startsWith(bytes: Uint8Array, signature: number[]) {
  return signature.every((value, index) => bytes[index] === value);
}

/** The declared MIME type alone is client-controlled; verify magic bytes like the other upload routes do. */
function detectImageType(bytes: Uint8Array) {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])) return "image/webp";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return "image/gif";
  return null;
}


async function keyFor(email: string) {
  const bytes = new TextEncoder().encode(email);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return "avatars/" + Array.from(new Uint8Array(digest)).map((item) => item.toString(16).padStart(2, "0")).join("");
}

export async function GET(request: Request) {
  const guard = await guardBrowserApi(request);
  if (guard) return guard;
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
  const guard = await guardBrowserApi(request);
  if (guard) return guard;
  const email = getCurrentUser();
  const form = await request.formData();
  const file = form.get("avatar");
  if (!(file instanceof File)) return Response.json({ error: "请选择头像图片" }, { status: 400 });
  if (!allowed.has(file.type)) return Response.json({ error: "仅支持 JPG、PNG、WebP 或 GIF" }, { status: 415 });
  if (file.size > 8 * 1024 * 1024) return Response.json({ error: "图片不能超过 8 MB" }, { status: 413 });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const detectedType = detectImageType(bytes);
  if (!detectedType || detectedType !== file.type) return Response.json({ error: "图片内容与 MIME 类型不匹配" }, { status: 415 });
  const payload = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  await env.BUCKET.put(await keyFor(email), payload, { httpMetadata: { contentType: detectedType } });
  return Response.json({ ok: true, url: `/api/avatar?v=${Date.now()}` });
}

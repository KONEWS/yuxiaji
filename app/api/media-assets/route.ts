import { env } from "cloudflare:workers";
import { getCurrentUser } from "../../lib/current-user";

const allowed = new Set(["image/jpeg", "image/png", "image/webp"]);

function declaredImageType(value: string) {
  const normalized = value.split(";", 1)[0].trim().toLowerCase();
  return normalized === "image/jpg" ? "image/jpeg" : normalized;
}

async function keyFor(email: string, version: string) {
  const bytes = new TextEncoder().encode(email);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest)).map((item) => item.toString(16).padStart(2, "0")).join("");
  return `media-assets/${hash}/gallery/${version}`;
}

function startsWith(bytes: Uint8Array, signature: number[]) {
  return signature.every((value, index) => bytes[index] === value);
}

function detectImageType(bytes: Uint8Array) {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])) return "image/webp";
  return null;
}

function assetVersion(value: string | null) {
  const version = value?.trim() || "";
  // Numeric values remain valid for thumbnails created before this change.
  if (/^[0-9]{1,20}$/.test(version)) return Number(version) > 0 ? version : null;
  return /^[A-Za-z0-9_-]{16,96}$/.test(version) ? version : null;
}

export async function GET(request: Request) {
  const email = getCurrentUser();
  const version = assetVersion(new URL(request.url).searchParams.get("v"));
  if (!version) return new Response("Not found", { status: 404 });
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
    const declaredType = declaredImageType(file.type);
    if (!allowed.has(declaredType)) return Response.json({ error: "缩略图必须是 JPG、PNG 或 WebP" }, { status: 415 });
    if (file.size > 5 * 1024 * 1024) return Response.json({ error: "缩略图不能超过 5 MB" }, { status: 413 });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const detectedType = detectImageType(bytes);
    if (!detectedType || detectedType !== declaredType) return Response.json({ error: "图片内容与 MIME 类型不匹配" }, { status: 415 });
    const version = crypto.randomUUID();
    const payload = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    await env.BUCKET.put(await keyFor(email, version), payload, { httpMetadata: { contentType: detectedType } });
    return Response.json({ ok: true, url: `/api/media-assets?v=${version}` });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "上传失败" }, { status: 500 });
  }
}

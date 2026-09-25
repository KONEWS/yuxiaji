import { env } from "cloudflare:workers";
import { getCurrentUser } from "../../lib/current-user";

const allowed = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const purposes = new Set(["receipt", "cover"]);

function declaredImageType(value: string) {
  const normalized = value.split(";", 1)[0].trim().toLowerCase();
  return normalized === "image/jpg" ? "image/jpeg" : normalized;
}

function startsWith(bytes: Uint8Array, signature: number[]) {
  return signature.every((value, index) => bytes[index] === value);
}

function detectImageType(bytes: Uint8Array) {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])) return "image/webp";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return "image/gif";
  return null;
}

function keyFor(email: string, purpose: string, version: string) {
  return `device-assets/${encodeURIComponent(email)}/${purpose}/${version}`;
}

function assetVersion(value: string | null) {
  const version = value?.trim() || "";
  if (/^[0-9]{1,20}$/.test(version)) return Number(version) > 0 ? version : null;
  return /^[A-Za-z0-9_-]{16,96}$/.test(version) ? version : null;
}

/** 读取设备图片（购买凭证截图 / 封面图） */
export async function GET(request: Request) {
  const email = getCurrentUser();
  const url = new URL(request.url);
  const purpose = url.searchParams.get("purpose") || "receipt";
  const version = assetVersion(url.searchParams.get("v"));
  if (!purposes.has(purpose) || !version) {
    return new Response("Not found", { status: 404 });
  }
  const object = await env.BUCKET.get(keyFor(email, purpose, version));
  if (!object) return new Response("Not found", { status: 404 });
  const responseHeaders = new Headers();
  object.writeHttpMetadata(responseHeaders);
  responseHeaders.set("etag", object.httpEtag);
  responseHeaders.set("cache-control", "private, max-age=3600");
  return new Response(object.body, { headers: responseHeaders });
}

/** 上传设备图片，返回 /api/device-assets?purpose=...&v=<版本号> 地址 */
export async function POST(request: Request) {
  const email = getCurrentUser();
  try {
    const form = await request.formData();
    const file = form.get("image");
    const purpose = String(form.get("purpose") || "receipt");
    if (!(file instanceof File)) return Response.json({ error: "请选择图片文件" }, { status: 400 });
    if (!purposes.has(purpose)) return Response.json({ error: "未知用途" }, { status: 400 });
    const declaredType = declaredImageType(file.type);
    if (!allowed.has(declaredType)) return Response.json({ error: "仅支持 JPG、PNG、WebP 或 GIF" }, { status: 415 });
    if (file.size > 8 * 1024 * 1024) return Response.json({ error: "图片不能超过 8 MB" }, { status: 413 });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const detectedType = detectImageType(bytes);
    if (!detectedType || detectedType !== declaredType) return Response.json({ error: "图片内容与 MIME 类型不匹配" }, { status: 415 });
    const version = crypto.randomUUID();
    const payload = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    await env.BUCKET.put(keyFor(email, purpose, version), payload, { httpMetadata: { contentType: detectedType } });
    return Response.json({ ok: true, url: `/api/device-assets?purpose=${purpose}&v=${version}` });
  } catch (error) {
    const message = error instanceof Error ? error.message : "上传失败";
    return Response.json({ error: message }, { status: 500 });
  }
}

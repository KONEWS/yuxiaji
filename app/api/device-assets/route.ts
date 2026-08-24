import { env } from "cloudflare:workers";
import { getCurrentUser } from "../../lib/current-user";

const allowed = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const purposes = new Set(["receipt", "cover"]);

function keyFor(email: string, purpose: string, version: number) {
  return `device-assets/${encodeURIComponent(email)}/${purpose}/${version}`;
}

/** 读取设备图片（购买凭证截图 / 封面图） */
export async function GET(request: Request) {
  const email = getCurrentUser();
  const url = new URL(request.url);
  const purpose = url.searchParams.get("purpose") || "receipt";
  const version = Number(url.searchParams.get("v"));
  if (!purposes.has(purpose) || !Number.isFinite(version) || version <= 0) {
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
    if (!allowed.has(file.type)) return Response.json({ error: "仅支持 JPG、PNG、WebP 或 GIF" }, { status: 415 });
    if (file.size > 8 * 1024 * 1024) return Response.json({ error: "图片不能超过 8 MB" }, { status: 413 });
    const version = Date.now();
    await env.BUCKET.put(keyFor(email, purpose, version), file.stream(), { httpMetadata: { contentType: file.type } });
    return Response.json({ ok: true, url: `/api/device-assets?purpose=${purpose}&v=${version}` });
  } catch (error) {
    const message = error instanceof Error ? error.message : "上传失败";
    return Response.json({ error: message }, { status: 500 });
  }
}

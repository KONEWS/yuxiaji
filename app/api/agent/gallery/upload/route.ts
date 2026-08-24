import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { userSubjects } from "../../../../../db/schema";
import { authenticateAgent, isAgentIdentity, requireAgentPermission } from "../../../../lib/agent-auth";
import { agentJson, finishAgentOperation, reserveAgentOperation } from "../../../../lib/agent-operations";

const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MIME_ALIASES: Record<string, string> = {
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "image/x-png": "image/png",
};

type ImagesBinding = {
  input(stream: ReadableStream): {
    transform(options: Record<string, unknown>): {
      output(options: { format: "image/webp"; quality: number }): Promise<{ response(): Response }>;
    };
  };
};

type RuntimeEnv = typeof env & { IMAGES?: ImagesBinding };

function bytesStartWith(bytes: Uint8Array, signature: number[]) {
  return signature.every((value, index) => bytes[index] === value);
}

function detectImageType(bytes: Uint8Array) {
  if (bytesStartWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (bytesStartWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (bytesStartWith(bytes, [0x52, 0x49, 0x46, 0x46]) && bytesStartWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])) return "image/webp";
  return null;
}

function normalizeDeclaredType(value: string) {
  const type = value.split(";", 1)[0].trim().toLowerCase();
  if (!type || type === "application/octet-stream" || type === "binary/octet-stream") return "";
  return MIME_ALIASES[type] || type;
}

function parsePositiveId(value: FormDataEntryValue | string | null) {
  const id = Number(typeof value === "string" ? value : "");
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function userHash(userKey: string) {
  const bytes = new TextEncoder().encode(userKey);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((item) => item.toString(16).padStart(2, "0")).join("");
}

async function imageHash(bytes: Uint8Array) {
  const source = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", source);
  return Array.from(new Uint8Array(digest)).map((item) => item.toString(16).padStart(2, "0")).join("");
}

function responsePayload(identity: { agent: string }, assetId: number, objectKey: string, galleryId: number | null, thumbnailUrl: string, hash: string) {
  const asset = { assetId, ...(galleryId ? { galleryId } : {}), thumbnailUrl, thumbnail: thumbnailUrl, objectKey, imageHash: hash, contentType: "image/webp" };
  return { ok: true, source: "openclaw", agent: identity.agent, assetId, ...(galleryId ? { galleryId } : {}), thumbnailUrl, objectKey, imageHash: hash, asset };
}

export async function POST(request: Request) {
  const identity = authenticateAgent(request);
  if (!isAgentIdentity(identity)) return identity;
  const denied = requireAgentPermission(identity, "gallery:create");
  if (denied) return denied;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return agentJson({ error: "请求必须是 multipart/form-data" }, 400);
  }
  const idempotencyKey = String(form.get("idempotencyKey") || request.headers.get("idempotency-key") || request.headers.get("x-idempotency-key") || "").trim();
  const file = form.get("image");
  if (!(file instanceof File)) return agentJson({ error: "请选择图片文件" }, 400);
  if (!idempotencyKey) return agentJson({ error: "上传需要 idempotencyKey" }, 400);
  const url = new URL(request.url);
  const galleryId = parsePositiveId(form.get("galleryId") || form.get("id") || url.searchParams.get("galleryId") || url.searchParams.get("id"));
  if (file.size <= 0 || file.size > MAX_INPUT_BYTES) return agentJson({ error: "原始图片不能超过 20 MB" }, 413);

  const input = new Uint8Array(await file.arrayBuffer());
  const detectedType = detectImageType(input);
  const declaredType = normalizeDeclaredType(file.type || "");
  if (!detectedType || !ALLOWED_TYPES.has(detectedType)) return agentJson({ error: "图片必须是有效的 JPEG、PNG 或 WebP" }, 415);
  if (declaredType && (!ALLOWED_TYPES.has(declaredType) || declaredType !== detectedType)) {
    return agentJson({ error: "图片内容与 MIME 类型不匹配", details: `声明为 ${declaredType || file.type}，实际为 ${detectedType}` }, 415);
  }

  if (galleryId) {
    let galleryExists: { id: number }[];
    try {
      galleryExists = await getDb().select({ id: userSubjects.id }).from(userSubjects).where(and(
        eq(userSubjects.id, galleryId),
        eq(userSubjects.userKey, identity.userKey),
        eq(userSubjects.type, "visual"),
      )).limit(1);
    } catch (error) {
      return agentJson({ error: "读取画廊记录失败", details: error instanceof Error ? error.message : String(error) }, 500);
    }
    if (!galleryExists.length) return agentJson({ error: "画廊记录不存在或无权修改", details: `galleryId=${galleryId}` }, 404);
  }

  let hash: string;
  try {
    hash = await imageHash(input);
  } catch (error) {
    return agentJson({ error: "图片 hash 计算失败", details: error instanceof Error ? error.message : String(error) }, 500);
  }

  let reservation: Awaited<ReturnType<typeof reserveAgentOperation>>;
  try {
    reservation = await reserveAgentOperation(identity, {
      request,
      body: { idempotencyKey, ...(galleryId ? { galleryId } : {}), contentType: detectedType, size: file.size, imageHash: hash },
      resource: "gallery_asset",
      action: "upload",
      resourceId: galleryId,
    });
  } catch (error) {
    return agentJson({ error: "上传操作记录失败", details: error instanceof Error ? error.message : String(error) }, 500);
  }
  if (reservation.kind !== "reserved") return reservation.response;

  let objectKey = "";
  try {
    const images = (env as RuntimeEnv).IMAGES;
    if (!images) {
      const payload = { error: "Cloudflare Images 绑定不可用，暂时无法生成缩略图" };
      await finishAgentOperation(reservation.id, 503, payload);
      return agentJson(payload, 503);
    }
    const transformed = await images.input(new Blob([input], { type: detectedType }).stream())
      .transform({ width: 1600, fit: "scale-down" })
      .output({ format: "image/webp", quality: 82 });
    const thumbnail = await transformed.response();
    if (!thumbnail.ok || !thumbnail.body) throw new Error("缩略图生成失败");
    const thumbnailBytes = await thumbnail.arrayBuffer();
    if (thumbnailBytes.byteLength > MAX_THUMBNAIL_BYTES) throw new Error("生成的缩略图不能超过 5 MB");
    objectKey = `media-assets/${await userHash(identity.userKey)}/gallery/${reservation.id}`;
    await env.BUCKET.put(objectKey, thumbnailBytes, { httpMetadata: { contentType: "image/webp" } });
    const thumbnailUrl = `/api/media-assets?v=${reservation.id}`;
    if (galleryId) {
      const [updated] = await getDb().update(userSubjects).set({ thumbnail: thumbnailUrl, updatedAt: new Date() }).where(and(
        eq(userSubjects.id, galleryId),
        eq(userSubjects.userKey, identity.userKey),
        eq(userSubjects.type, "visual"),
      )).returning({ id: userSubjects.id });
      if (!updated) throw new Error(`画廊记录更新失败: galleryId=${galleryId}`);
    }
    const payload = responsePayload(identity, reservation.id, objectKey, galleryId, thumbnailUrl, hash);
    await finishAgentOperation(reservation.id, 201, payload);
    return agentJson(payload, 201);
  } catch (error) {
    if (objectKey) {
      const bucket = env.BUCKET as unknown as { delete?: (key: string) => Promise<void> };
      try { await bucket.delete?.(objectKey); } catch { /* best-effort orphan cleanup */ }
    }
    const payload = { error: "图片上传失败", details: error instanceof Error ? error.message : String(error) };
    await finishAgentOperation(reservation.id, 500, payload).catch(() => undefined);
    return agentJson(payload, 500);
  }
}

export function GET() {
  return agentJson({ error: "请使用 POST 上传画廊图片" }, 405, { allow: "POST" });
}

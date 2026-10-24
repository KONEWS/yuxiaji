import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../db";
import { userSubjects } from "../../db/schema";
import { authenticateAgent, isAgentIdentity } from "./agent-auth";
import { agentJson, finishAgentOperation, reserveAgentOperation } from "./agent-operations";
import { normalizeMediaMetadata } from "./constants";
import { chatGPTFileUrl, downloadCoverImage, transformCoverImage, type CoverImagesBinding } from "./mcp-file-image";
import { duplicateUploadWarning, findUploadDuplicate } from "./upload-duplicates";

async function hash(value: string | Uint8Array) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Internal MCP handler only: no public upload route, token or header can create
// the ChatGPT identity. The optional processor supports isolated runtime tests.
export async function uploadMusicCover(request: Request, processImage?: (bytes: Uint8Array) => Promise<Uint8Array>) {
  const identity = authenticateAgent(request);
  if (!isAgentIdentity(identity)) return identity;
  if (identity.agent !== "chatgpt") return agentJson({ error: "仅支持已授权的内容连接" }, 403);
  const body = await request.json() as { id: number; expectedTitle: string; idempotencyKey: string; file: { download_url: string; file_id: string; mime_type?: string } };
  let fileUrl: URL;
  try { fileUrl = chatGPTFileUrl(body.file?.download_url); }
  catch (error) { return agentJson({ error: error instanceof Error ? error.message : "文件引用无效" }, 400); }
  const db = getDb();
  const conditions = and(eq(userSubjects.userKey, identity.userKey), eq(userSubjects.id, body.id), eq(userSubjects.type, "music"));
  const [existing] = await db.select().from(userSubjects).where(conditions).limit(1);
  if (!existing) return agentJson({ error: "音乐条目不存在" }, 404);
  if (existing.title !== body.expectedTitle) return agentJson({ error: "音乐标题不匹配" }, 409);
  const fingerprint = await hash(JSON.stringify([body.id, body.expectedTitle, body.file.file_id]));
  const reservation = await reserveAgentOperation(identity, {
    request, body: { idempotencyKey: body.idempotencyKey, fingerprint }, resource: "music_cover", action: "upload", resourceId: body.id,
  });
  if (reservation.kind !== "reserved") {
    if (reservation.kind === "replayed") {
      const previous = await reservation.response.clone().json() as { uploadFingerprint?: string };
      if (previous.uploadFingerprint !== fingerprint) return agentJson({ error: "幂等键与原封面上传不一致" }, 409);
    }
    return reservation.response;
  }
  const image = `/api/media-assets?v=${reservation.id}`;
  const objectKey = `media-assets/${await hash(identity.userKey)}/gallery/${reservation.id}`;
  let stored = false;
  let attached = false;
  let stage = "service";
  try {
    const images = (env as typeof env & { IMAGES?: CoverImagesBinding }).IMAGES;
    if (!processImage && !images) throw new Error("封面转换服务不可用");
    stage = "download";
    const input = await downloadCoverImage(fileUrl, body.file.mime_type);
    stage = "duplicate_check";
    const imageHash = await hash(input.bytes);
    const match = await findUploadDuplicate(identity.userKey, imageHash, body.id);
    if (match?.existingId === body.id && match.image === existing.image) {
      const payload = { ok: true, id: body.id, image: existing.image, imageHash, uploadFingerprint: fingerprint, ...duplicateUploadWarning(match, true) };
      await finishAgentOperation(reservation.id, 200, payload);
      return agentJson(payload);
    }
    stage = "transform";
    const output = processImage ? await processImage(input.bytes) : await transformCoverImage(input.bytes, images!);
    const payloadBytes = output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength) as ArrayBuffer;
    stage = "store";
    await env.BUCKET.put(objectKey, payloadBytes, { httpMetadata: { contentType: "image/webp" } });
    stored = true;
    let metadata: Record<string, unknown>;
    try { metadata = JSON.parse(existing.metadata); } catch { metadata = {}; }
    stage = "attach";
    const [saved] = await db.update(userSubjects).set({
      image, metadata: JSON.stringify(normalizeMediaMetadata({ ...metadata, coverPositionX: 50, coverPositionY: 50, coverZoom: 100 })), updatedAt: new Date(),
    }).where(and(conditions, eq(userSubjects.title, body.expectedTitle), eq(userSubjects.updatedAt, existing.updatedAt))).returning({ id: userSubjects.id });
    if (!saved) throw new Error("音乐条目已被其他操作修改");
    attached = true;
    const payload = { ok: true, id: body.id, image, imageHash, uploadFingerprint: fingerprint, ...(match ? duplicateUploadWarning(match, false) : {}) };
    stage = "confirm";
    await finishAgentOperation(reservation.id, 200, payload);
    return agentJson(payload);
  } catch (error) {
    // Never persist or return signed file URLs, underlying fetch errors or tokens.
    if (stored && !attached) {
      // A D1 response can fail after committing. Keep an asset if the update's
      // outcome is uncertain, rather than deleting a possibly attached cover.
      try {
        const references = await db.select({ id: userSubjects.id }).from(userSubjects).where(and(
          eq(userSubjects.userKey, identity.userKey), eq(userSubjects.image, image),
        )).limit(1);
        const bucket = env.BUCKET as unknown as { delete(key: string): Promise<void> };
        if (!references.length) await bucket.delete(objectKey);
      } catch { /* Preserve the object when reference status is uncertain. */ }
    }
    // Expose only fixed stages, known validation reasons and numeric statuses.
    // Never include upstream messages, request URLs or file references.
    const reasons: Record<string, string> = {
      "封面转换服务不可用": "images_unavailable",
      "图片超过大小限制": "image_too_large",
      "图片文件为空": "empty_image",
      "封面必须是有效的 JPG、PNG 或 WebP 图片": "invalid_image",
      "图片内容与 MIME 类型不匹配": "mime_mismatch",
      "封面转换失败": "invalid_output",
      "音乐条目已被其他操作修改": "record_changed",
    };
    const message = error instanceof Error ? error.message : "";
    const upstreamStatus = error instanceof Error && "status" in error && typeof error.status === "number"
      && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : undefined;
    const downloadReason = error instanceof Error && "reason" in error
      && (error.reason === "download_network_error" || error.reason === "download_redirect_error") ? error.reason : undefined;
    const reason = reasons[message] ?? downloadReason ?? (upstreamStatus ? "download_http_error" : "operation_failed");
    const retrySafe = ["service", "download", "transform"].includes(stage) && (reason === "images_unavailable" || reason === "download_network_error" || reason === "operation_failed" || upstreamStatus === 429 || (upstreamStatus !== undefined && upstreamStatus >= 500));
    const payload = { error: retrySafe ? "封面上传暂时失败，可稍后使用原操作编号重试" : "封面上传未完成，请读取条目核对", code: "music_cover_upload_failed",
      stage, reason, retryable: retrySafe, ...(retrySafe ? { retryAfterSeconds: 5 } : {}), ...(upstreamStatus ? { upstreamStatus } : {}), uploadFingerprint: fingerprint };
    await finishAgentOperation(reservation.id, 502, payload, { retrySafe }).catch(() => undefined);
    return agentJson(payload, 502);
  }
}

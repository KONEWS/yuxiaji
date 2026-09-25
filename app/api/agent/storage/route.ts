import { getDb } from "../../../../db";
import { authenticateAgent, isAgentIdentity, requireAgentPermission, type AgentIdentity } from "../../../lib/agent-auth";
import { agentJson, finishAgentOperation, reserveAgentOperation } from "../../../lib/agent-operations";
import {
  createMediaStorageLink,
  deleteMediaStorageLink,
  listMediaStorageLinks,
  MediaStorageLinkStoreError,
  updateMediaStorageLink,
} from "../../../lib/media-storage-link-store";
import { MediaStorageLinkValidationError } from "../../../lib/media-storage-links";

function positiveId(value: unknown) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function jsonBody(request: Request) {
  try {
    const value = await request.clone().json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function mediaIdFrom(request: Request, body?: Record<string, unknown>) {
  return positiveId(new URL(request.url).searchParams.get("mediaId") ?? body?.mediaId);
}

function linkIdFrom(request: Request, body?: Record<string, unknown>) {
  return positiveId(new URL(request.url).searchParams.get("id") ?? body?.id);
}

function details(error: unknown) {
  return (error instanceof Error ? error.message : String(error || "未知错误")).slice(0, 2000);
}

function failure(error: unknown, fallback: string) {
  const status = storageErrorStatus(error);
  return agentJson({ error: error instanceof Error ? error.message : fallback, details: details(error) }, status);
}

function storageErrorStatus(error: unknown) {
  return error instanceof MediaStorageLinkStoreError || error instanceof MediaStorageLinkValidationError
    ? error.status
    : 500;
}

async function finish(id: number, status: number, payload: unknown) {
  try {
    await finishAgentOperation(id, status, payload);
    return null;
  } catch (error) {
    return error;
  }
}

function permissionFor(action: "create" | "update" | "delete") {
  return `storage:${action}` as const;
}

async function writeStorage(request: Request, identity: AgentIdentity, action: "create" | "update" | "delete", body: Record<string, unknown>) {
  const mediaId = mediaIdFrom(request, body);
  const id = action === "create" ? null : linkIdFrom(request, body);
  if (!mediaId) return agentJson({ error: "缺少正整数 mediaId" }, 400);
  if (action !== "create" && !id) return agentJson({ error: "修改或删除需要正整数 id" }, 400);
  const denied = requireAgentPermission(identity, permissionFor(action));
  if (denied) return denied;
  let reservation: Awaited<ReturnType<typeof reserveAgentOperation>>;
  try {
    reservation = await reserveAgentOperation(identity, {
      request,
      body,
      resource: "storage",
      action,
      resourceId: id,
    });
  } catch (error) {
    return failure(error, "存储链接操作记录失败");
  }
  if (reservation.kind !== "reserved") return reservation.response;

  try {
    const db = getDb();
    let result: unknown;
    let status = 200;
    if (action === "create") {
      result = await createMediaStorageLink(db, identity.userKey, mediaId, body);
      status = 201;
    } else if (action === "update") {
      result = await updateMediaStorageLink(db, identity.userKey, mediaId, id!, body);
    } else {
      result = await deleteMediaStorageLink(db, identity.userKey, mediaId, id!);
    }
    const storageLinks = await listMediaStorageLinks(db, identity.userKey, mediaId);
    const payload = {
      ok: true,
      source: "openclaw",
      agent: identity.agent,
      idempotencyKey: reservation.idempotencyKey,
      mediaId,
      ...(action === "delete" ? { deleted: result } : { storageLink: result }),
      storageLinks,
    };
    const finishError = await finish(reservation.id, status, payload);
    if (finishError) return failure(finishError, "存储链接已写入，但操作记录失败");
    return agentJson(payload, status);
  } catch (error) {
    const payload = { error: error instanceof Error ? error.message : "存储链接写入失败", details: details(error) };
    const status = storageErrorStatus(error);
    const finishError = await finish(reservation.id, status, payload);
    if (finishError) payload.details = `${payload.details}; 操作记录更新失败: ${details(finishError)}`.slice(0, 2000);
    return agentJson(payload, status);
  }
}

export async function GET(request: Request) {
  const identity = authenticateAgent(request);
  if (!isAgentIdentity(identity)) return identity;
  const denied = requireAgentPermission(identity, "storage:read");
  if (denied) return denied;
  const mediaId = mediaIdFrom(request);
  if (!mediaId) return agentJson({ error: "缺少正整数 mediaId" }, 400);
  try {
    const storageLinks = await listMediaStorageLinks(getDb(), identity.userKey, mediaId);
    return agentJson({ mediaId, storageLinks, source: "openclaw", agent: identity.agent });
  } catch (error) {
    return failure(error, "读取存储链接失败");
  }
}

export async function POST(request: Request) {
  const identity = authenticateAgent(request);
  if (!isAgentIdentity(identity)) return identity;
  const body = await jsonBody(request);
  if (!body) return agentJson({ error: "请求体必须是 JSON 对象" }, 400);
  return writeStorage(request, identity, "create", body);
}

export async function PATCH(request: Request) {
  const identity = authenticateAgent(request);
  if (!isAgentIdentity(identity)) return identity;
  const body = await jsonBody(request);
  if (!body) return agentJson({ error: "请求体必须是 JSON 对象" }, 400);
  return writeStorage(request, identity, "update", body);
}

export async function DELETE(request: Request) {
  const identity = authenticateAgent(request);
  if (!isAgentIdentity(identity)) return identity;
  return writeStorage(request, identity, "delete", {});
}

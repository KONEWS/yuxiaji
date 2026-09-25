import { getDb } from "../../../../db";
import { getCurrentUser } from "../../../lib/current-user";
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
    const value = await request.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function failure(error: unknown, fallback = "存储链接操作失败") {
  if (error instanceof MediaStorageLinkStoreError || error instanceof MediaStorageLinkValidationError) {
    return Response.json({ error: error.message }, { status: error.status, headers: { "cache-control": "no-store" } });
  }
  return Response.json({ error: error instanceof Error ? error.message : fallback }, { status: 500, headers: { "cache-control": "no-store" } });
}

function mediaIdFrom(request: Request, body?: Record<string, unknown>) {
  return positiveId(new URL(request.url).searchParams.get("mediaId") ?? body?.mediaId);
}

function linkIdFrom(request: Request, body?: Record<string, unknown>) {
  return positiveId(new URL(request.url).searchParams.get("id") ?? body?.id);
}

export async function GET(request: Request) {
  const mediaId = mediaIdFrom(request);
  if (!mediaId) return Response.json({ error: "缺少正整数 mediaId" }, { status: 400 });
  try {
    const storageLinks = await listMediaStorageLinks(getDb(), getCurrentUser(request), mediaId);
    return Response.json({ mediaId, storageLinks }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return failure(error, "读取存储链接失败");
  }
}

export async function POST(request: Request) {
  const body = await jsonBody(request);
  if (!body) return Response.json({ error: "请求体必须是 JSON 对象" }, { status: 400 });
  const mediaId = mediaIdFrom(request, body);
  if (!mediaId) return Response.json({ error: "缺少正整数 mediaId" }, { status: 400 });
  try {
    const storageLink = await createMediaStorageLink(getDb(), getCurrentUser(request), mediaId, body);
    const storageLinks = await listMediaStorageLinks(getDb(), getCurrentUser(request), mediaId);
    return Response.json({ ok: true, mediaId, storageLink, storageLinks }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return failure(error, "添加存储链接失败");
  }
}

export async function PATCH(request: Request) {
  const body = await jsonBody(request);
  if (!body) return Response.json({ error: "请求体必须是 JSON 对象" }, { status: 400 });
  const mediaId = mediaIdFrom(request, body);
  const id = linkIdFrom(request, body);
  if (!mediaId || !id) return Response.json({ error: "PATCH 需要正整数 mediaId 和 id" }, { status: 400 });
  try {
    const storageLink = await updateMediaStorageLink(getDb(), getCurrentUser(request), mediaId, id, body);
    const storageLinks = await listMediaStorageLinks(getDb(), getCurrentUser(request), mediaId);
    return Response.json({ ok: true, mediaId, storageLink, storageLinks }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return failure(error, "修改存储链接失败");
  }
}

export async function DELETE(request: Request) {
  const mediaId = mediaIdFrom(request);
  const id = linkIdFrom(request);
  if (!mediaId || !id) return Response.json({ error: "DELETE 需要正整数 mediaId 和 id" }, { status: 400 });
  try {
    const deleted = await deleteMediaStorageLink(getDb(), getCurrentUser(request), mediaId, id);
    const storageLinks = await listMediaStorageLinks(getDb(), getCurrentUser(request), mediaId);
    return Response.json({ ok: true, deleted, storageLinks }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return failure(error, "删除存储链接失败");
  }
}

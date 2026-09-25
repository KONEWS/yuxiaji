import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../db";
import { mediaStorageLinks, userSubjects } from "../../db/schema";
import {
  MEDIA_STORAGE_LINK_LIMITS,
  MediaStorageLinkValidationError,
  presentMediaStorageLink,
  sanitizeMediaStorageLink,
  type MediaStorageLinkInput,
  type PresentedMediaStorageLink,
} from "./media-storage-links";
import { groupStorageLinkRows, normalizeStorageMediaIds, queryStorageLinkBatches } from "./media-storage-link-batches";

type Database = ReturnType<typeof getDb>;

export class MediaStorageLinkStoreError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "MediaStorageLinkStoreError";
  }
}

function normalizeStoreError(error: unknown): never {
  if (error instanceof MediaStorageLinkStoreError) throw error;
  if (error instanceof MediaStorageLinkValidationError) throw new MediaStorageLinkStoreError(error.message, error.status);
  throw error;
}

function normalizeDatabaseError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error || "");
  if (message.includes("media storage link limit exceeded")) {
    throw new MediaStorageLinkStoreError(`每条媒体最多保存 ${MEDIA_STORAGE_LINK_LIMITS.maxPerMedia} 个存储链接`);
  }
  if (message.includes("media_storage_links_primary_idx") || message.includes("UNIQUE constraint failed: media_storage_links.user_key, media_storage_links.media_id")) {
    throw new MediaStorageLinkStoreError("该媒体已有主存储，请刷新后重试", 409);
  }
  throw error;
}

function mediaScope(userKey: string, mediaId: number) {
  return and(eq(userSubjects.id, mediaId), eq(userSubjects.userKey, userKey));
}

function linkScope(userKey: string, mediaId: number, id: number) {
  return and(
    eq(mediaStorageLinks.id, id),
    eq(mediaStorageLinks.userKey, userKey),
    eq(mediaStorageLinks.mediaId, mediaId),
  );
}

async function requireOwnedMedia(db: Database, userKey: string, mediaId: number) {
  const [media] = await db.select({ id: userSubjects.id }).from(userSubjects).where(mediaScope(userKey, mediaId)).limit(1);
  if (!media) throw new MediaStorageLinkStoreError("媒体记录不存在或无权访问", 404);
}

async function rawLinks(db: Database, userKey: string, mediaId: number) {
  return db.select().from(mediaStorageLinks).where(and(
    eq(mediaStorageLinks.userKey, userKey),
    eq(mediaStorageLinks.mediaId, mediaId),
  )).orderBy(desc(mediaStorageLinks.isPrimary), asc(mediaStorageLinks.id));
}

export async function listMediaStorageLinks(db: Database, userKey: string, mediaId: number) {
  await requireOwnedMedia(db, userKey, mediaId);
  return (await rawLinks(db, userKey, mediaId)).map(presentMediaStorageLink);
}

export async function mediaStorageLinksByMediaIds(db: Database, userKey: string, mediaIds: number[]) {
  const ids = normalizeStorageMediaIds(mediaIds);
  if (!ids.length) return new Map<number, PresentedMediaStorageLink[]>();
  const rows = await queryStorageLinkBatches(ids, (batchIds) => db.select().from(mediaStorageLinks).where(and(
    eq(mediaStorageLinks.userKey, userKey),
    inArray(mediaStorageLinks.mediaId, batchIds),
  )));
  return groupStorageLinkRows(rows, presentMediaStorageLink);
}

export async function createMediaStorageLink(db: Database, userKey: string, mediaId: number, value: unknown) {
  await requireOwnedMedia(db, userKey, mediaId);
  const existing = await rawLinks(db, userKey, mediaId);
  if (existing.length >= MEDIA_STORAGE_LINK_LIMITS.maxPerMedia) {
    throw new MediaStorageLinkStoreError(`每条媒体最多保存 ${MEDIA_STORAGE_LINK_LIMITS.maxPerMedia} 个存储链接`);
  }
  let input: MediaStorageLinkInput;
  try {
    input = sanitizeMediaStorageLink(value);
  } catch (error) {
    normalizeStoreError(error);
  }
  const isPrimary = input.isPrimary || existing.length === 0;
  const now = new Date();
  const createValues = {
    ...input,
    userKey,
    mediaId,
    isPrimary,
    createdAt: now,
    updatedAt: now,
  };
  if (!isPrimary) {
    let created: typeof mediaStorageLinks.$inferSelect | undefined;
    try {
      [created] = await db.insert(mediaStorageLinks).values(createValues).returning();
    } catch (error) {
      normalizeDatabaseError(error);
    }
    if (!created) throw new MediaStorageLinkStoreError("添加存储链接失败", 500);
    return presentMediaStorageLink(created);
  }
  let created: typeof mediaStorageLinks.$inferSelect | undefined;
  try {
    const [, createdRows] = await db.batch([
      db.update(mediaStorageLinks).set({ isPrimary: false, updatedAt: now }).where(and(
        eq(mediaStorageLinks.userKey, userKey),
        eq(mediaStorageLinks.mediaId, mediaId),
      )),
      db.insert(mediaStorageLinks).values(createValues).returning(),
    ] as const);
    [created] = createdRows;
  } catch (error) {
    normalizeDatabaseError(error);
  }
  if (!created) throw new MediaStorageLinkStoreError("添加存储链接失败", 500);
  return presentMediaStorageLink(created);
}

export async function updateMediaStorageLink(db: Database, userKey: string, mediaId: number, id: number, value: unknown) {
  await requireOwnedMedia(db, userKey, mediaId);
  const links = await rawLinks(db, userKey, mediaId);
  const existing = links.find((row) => row.id === id);
  if (!existing) throw new MediaStorageLinkStoreError("存储链接不存在或无权修改", 404);
  const fallback: MediaStorageLinkInput = {
    provider: existing.provider,
    label: existing.label,
    url: existing.url,
    path: existing.path,
    isPrimary: Boolean(existing.isPrimary),
    note: existing.note,
  };
  let input: MediaStorageLinkInput;
  try {
    input = sanitizeMediaStorageLink(value, fallback);
  } catch (error) {
    normalizeStoreError(error);
  }
  const replacement = links.find((row) => row.id !== id);
  const next = { ...input, isPrimary: input.isPrimary || !replacement, updatedAt: new Date() };
  if (next.isPrimary) {
    const [, updatedRows] = await db.batch([
      db.update(mediaStorageLinks).set({ isPrimary: false, updatedAt: next.updatedAt }).where(and(
        eq(mediaStorageLinks.userKey, userKey),
        eq(mediaStorageLinks.mediaId, mediaId),
      )),
      db.update(mediaStorageLinks).set(next).where(linkScope(userKey, mediaId, id)).returning(),
    ] as const);
    const [updated] = updatedRows;
    if (!updated) throw new MediaStorageLinkStoreError("存储链接不存在或无权修改", 404);
    return presentMediaStorageLink(updated);
  }

  if (existing.isPrimary && replacement) {
    const [updatedRows] = await db.batch([
      db.update(mediaStorageLinks).set(next).where(linkScope(userKey, mediaId, id)).returning(),
      db.update(mediaStorageLinks).set({ isPrimary: true, updatedAt: next.updatedAt }).where(linkScope(userKey, mediaId, replacement.id)),
    ] as const);
    const [updated] = updatedRows;
    if (!updated) throw new MediaStorageLinkStoreError("存储链接不存在或无权修改", 404);
    return presentMediaStorageLink(updated);
  }

  const [updated] = await db.update(mediaStorageLinks).set(next).where(linkScope(userKey, mediaId, id)).returning();
  if (!updated) throw new MediaStorageLinkStoreError("存储链接不存在或无权修改", 404);
  return presentMediaStorageLink(updated);
}

export async function deleteMediaStorageLink(db: Database, userKey: string, mediaId: number, id: number) {
  await requireOwnedMedia(db, userKey, mediaId);
  const links = await rawLinks(db, userKey, mediaId);
  const existing = links.find((row) => row.id === id);
  if (!existing) throw new MediaStorageLinkStoreError("存储链接不存在或无权删除", 404);
  const replacement = links.find((row) => row.id !== id);
  if (existing.isPrimary && replacement) {
    const [deletedRows] = await db.batch([
      db.delete(mediaStorageLinks).where(linkScope(userKey, mediaId, id)).returning({ id: mediaStorageLinks.id }),
      db.update(mediaStorageLinks).set({ isPrimary: true, updatedAt: new Date() }).where(linkScope(userKey, mediaId, replacement.id)),
    ] as const);
    if (!deletedRows.length) throw new MediaStorageLinkStoreError("存储链接不存在或无权删除", 404);
  } else {
    const deletedRows = await db.delete(mediaStorageLinks).where(linkScope(userKey, mediaId, id)).returning({ id: mediaStorageLinks.id });
    if (!deletedRows.length) throw new MediaStorageLinkStoreError("存储链接不存在或无权删除", 404);
  }
  return { id, mediaId };
}

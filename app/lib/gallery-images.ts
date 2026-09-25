import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../db";
import { userSubjectImages, userSubjects } from "../../db/schema";
import { deleteMediaAsset } from "./media-storage";
import { groupGalleryImageRows, normalizeGallerySubjectIds, queryGalleryImageBatches } from "./gallery-image-batches";

export const MAX_GALLERY_IMAGES = 60;

export type GalleryImageInput = {
  id?: number;
  thumbnail: string;
  sourceUrl: string;
  imageHash: string;
  sortOrder: number;
  isCover: boolean;
  width: number | null;
  height: number | null;
  mime: string;
};

export type GalleryImageRow = typeof userSubjectImages.$inferSelect;
type Database = ReturnType<typeof getDb>;

function textValue(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function positiveDimension(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 100_000 ? parsed : null;
}

function imageMime(value: unknown) {
  const mime = textValue(value, 80).toLowerCase();
  return ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"].includes(mime) ? mime : "";
}

export function sanitizeGalleryImages(value: unknown): GalleryImageInput[] | null {
  if (!Array.isArray(value)) return null;
  const unique = new Set<string>();
  const images: GalleryImageInput[] = [];
  for (const candidate of value.slice(0, MAX_GALLERY_IMAGES)) {
    if (!candidate || Array.isArray(candidate)) continue;
    const record = typeof candidate === "string" ? { thumbnail: candidate } : typeof candidate === "object" ? candidate as Record<string, unknown> : null;
    if (!record) continue;
    const thumbnail = textValue(record.thumbnail ?? record.url, 500);
    if (!thumbnail || unique.has(thumbnail)) continue;
    unique.add(thumbnail);
    const rawId = Number(record.id);
    images.push({
      ...(Number.isInteger(rawId) && rawId > 0 ? { id: rawId } : {}),
      thumbnail,
      sourceUrl: textValue(record.sourceUrl, 1000),
      imageHash: textValue(record.imageHash, 128),
      sortOrder: images.length,
      isCover: Boolean(record.isCover),
      width: positiveDimension(record.width),
      height: positiveDimension(record.height),
      mime: imageMime(record.mime ?? record.contentType),
    });
  }
  const requestedCover = images.findIndex((image) => image.isCover);
  const coverIndex = requestedCover >= 0 ? requestedCover : images.length ? 0 : -1;
  return images.map((image, index) => ({ ...image, sortOrder: index, isCover: index === coverIndex }));
}

export function presentGalleryImage(row: GalleryImageRow) {
  return {
    id: row.id,
    subjectId: row.subjectId,
    thumbnail: row.thumbnail,
    url: row.thumbnail,
    sourceUrl: row.sourceUrl || undefined,
    imageHash: row.imageHash || undefined,
    sortOrder: row.sortOrder,
    isCover: Boolean(row.isCover),
    width: row.width || undefined,
    height: row.height || undefined,
    mime: row.mime || undefined,
    createdAt: row.createdAt instanceof Date ? row.createdAt.getTime() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.getTime() : row.updatedAt,
  };
}

/** Build a read-only compatibility image for a pre-migration cover. */
export function presentLegacyGalleryImage(subject: typeof userSubjects.$inferSelect) {
  if (!subject.thumbnail) return null;
  return {
    id: 0,
    subjectId: subject.id,
    thumbnail: subject.thumbnail,
    url: subject.thumbnail,
    sortOrder: 0,
    isCover: true,
    createdAt: subject.updatedAt instanceof Date ? subject.updatedAt.getTime() : subject.updatedAt,
    updatedAt: subject.updatedAt instanceof Date ? subject.updatedAt.getTime() : subject.updatedAt,
  };
}

export async function galleryImagesBySubjectIds(db: Database, userKey: string, subjectIds: number[]) {
  const ids = normalizeGallerySubjectIds(subjectIds);
  const grouped = new Map<number, GalleryImageRow[]>();
  if (!ids.length) return grouped;
  const rows = await queryGalleryImageBatches(ids, (batchIds) => db.select().from(userSubjectImages).where(and(
    eq(userSubjectImages.userKey, userKey),
    inArray(userSubjectImages.subjectId, batchIds),
  )).orderBy(asc(userSubjectImages.subjectId), asc(userSubjectImages.sortOrder), asc(userSubjectImages.id)));
  return groupGalleryImageRows(rows);
}

export async function galleryImagesForSubject(db: Database, userKey: string, subjectId: number) {
  return db.select().from(userSubjectImages).where(and(
    eq(userSubjectImages.userKey, userKey),
    eq(userSubjectImages.subjectId, subjectId),
  )).orderBy(asc(userSubjectImages.sortOrder), asc(userSubjectImages.id));
}

async function removeUnusedAssets(db: Database, userKey: string, candidates: string[]) {
  const urls = Array.from(new Set(candidates.filter(Boolean)));
  if (!urls.length) return;
  const [imageRefs, subjectRefs] = await Promise.all([
    db.select({ thumbnail: userSubjectImages.thumbnail }).from(userSubjectImages).where(and(
      eq(userSubjectImages.userKey, userKey),
      inArray(userSubjectImages.thumbnail, urls),
    )),
    db.select({ thumbnail: userSubjects.thumbnail }).from(userSubjects).where(and(
      eq(userSubjects.userKey, userKey),
      inArray(userSubjects.thumbnail, urls),
    )),
  ]);
  const retained = new Set([...imageRefs, ...subjectRefs].map((row) => row.thumbnail));
  await Promise.all(urls.filter((url) => !retained.has(url)).map((url) => deleteMediaAsset(url, userKey)));
}

export async function syncGalleryImages(db: Database, userKey: string, subjectId: number, value: unknown) {
  const images = sanitizeGalleryImages(value);
  if (!images) throw new Error("images 必须是数组");
  const existing = await galleryImagesForSubject(db, userKey, subjectId);
  const existingById = new Map(existing.map((row) => [row.id, row]));
  const existingByUrl = new Map(existing.map((row) => [row.thumbnail, row]));
  const retainedIds = new Set<number>();
  const now = new Date();

  for (const image of images) {
    const match = image.id ? existingById.get(image.id) : existingByUrl.get(image.thumbnail);
    if (match && match.thumbnail === image.thumbnail) {
      retainedIds.add(match.id);
      await db.update(userSubjectImages).set({
        sourceUrl: image.sourceUrl,
        imageHash: image.imageHash,
        sortOrder: image.sortOrder,
        isCover: image.isCover,
        width: image.width,
        height: image.height,
        mime: image.mime,
        updatedAt: now,
      }).where(and(
        eq(userSubjectImages.id, match.id),
        eq(userSubjectImages.userKey, userKey),
        eq(userSubjectImages.subjectId, subjectId),
      ));
      continue;
    }
    const duplicateUrl = existingByUrl.get(image.thumbnail);
    if (duplicateUrl) {
      retainedIds.add(duplicateUrl.id);
      await db.update(userSubjectImages).set({
        sourceUrl: image.sourceUrl,
        imageHash: image.imageHash,
        sortOrder: image.sortOrder,
        isCover: image.isCover,
        width: image.width,
        height: image.height,
        mime: image.mime,
        updatedAt: now,
      }).where(and(
        eq(userSubjectImages.id, duplicateUrl.id),
        eq(userSubjectImages.userKey, userKey),
        eq(userSubjectImages.subjectId, subjectId),
      ));
      continue;
    }
    const [created] = await db.insert(userSubjectImages).values({
      userKey,
      subjectId,
      thumbnail: image.thumbnail,
      sourceUrl: image.sourceUrl,
      imageHash: image.imageHash,
      sortOrder: image.sortOrder,
      isCover: image.isCover,
      width: image.width,
      height: image.height,
      mime: image.mime,
      createdAt: now,
      updatedAt: now,
    }).returning({ id: userSubjectImages.id });
    if (created) retainedIds.add(created.id);
  }

  const removed = existing.filter((row) => !retainedIds.has(row.id));
  if (removed.length) {
    await db.delete(userSubjectImages).where(and(
      eq(userSubjectImages.userKey, userKey),
      eq(userSubjectImages.subjectId, subjectId),
      inArray(userSubjectImages.id, removed.map((row) => row.id)),
    ));
  }
  const cover = images.find((image) => image.isCover)?.thumbnail || images[0]?.thumbnail || "";
  await db.update(userSubjects).set({ thumbnail: cover, updatedAt: now }).where(and(
    eq(userSubjects.id, subjectId),
    eq(userSubjects.userKey, userKey),
    eq(userSubjects.type, "visual"),
  ));
  await removeUnusedAssets(db, userKey, removed.map((row) => row.thumbnail));
  return galleryImagesForSubject(db, userKey, subjectId);
}

export async function appendGalleryImage(db: Database, userKey: string, subjectId: number, value: unknown) {
  const [image] = sanitizeGalleryImages([value]) || [];
  if (!image) throw new Error("缺少有效的画廊图片地址");
  const existing = await galleryImagesForSubject(db, userKey, subjectId);
  const duplicate = existing.find((row) => row.thumbnail === image.thumbnail || Boolean(image.imageHash && row.imageHash === image.imageHash));
  const requestedCover = Boolean((value as Record<string, unknown> | null)?.isCover);
  if (duplicate) {
    if (!requestedCover) return { image: duplicate, images: existing, duplicate: true };
    const now = new Date();
    await db.update(userSubjectImages).set({ isCover: false, updatedAt: now }).where(and(
      eq(userSubjectImages.userKey, userKey),
      eq(userSubjectImages.subjectId, subjectId),
    ));
    await db.update(userSubjectImages).set({ isCover: true, updatedAt: now }).where(and(
      eq(userSubjectImages.id, duplicate.id),
      eq(userSubjectImages.userKey, userKey),
      eq(userSubjectImages.subjectId, subjectId),
    ));
    await db.update(userSubjects).set({ thumbnail: duplicate.thumbnail, updatedAt: now }).where(and(
      eq(userSubjects.id, subjectId),
      eq(userSubjects.userKey, userKey),
      eq(userSubjects.type, "visual"),
    ));
    const promoted = { ...duplicate, isCover: true, updatedAt: now };
    return {
      image: promoted,
      images: existing.map((row) => row.id === duplicate.id ? promoted : { ...row, isCover: false, updatedAt: now }),
      duplicate: true,
    };
  }
  if (existing.length >= MAX_GALLERY_IMAGES) throw new Error(`每个画廊条目最多保存 ${MAX_GALLERY_IMAGES} 张图片`);
  const makeCover = requestedCover || existing.length === 0 || !existing.some((row) => row.isCover);
  const now = new Date();
  if (makeCover && existing.length) await db.update(userSubjectImages).set({ isCover: false, updatedAt: now }).where(and(
    eq(userSubjectImages.userKey, userKey),
    eq(userSubjectImages.subjectId, subjectId),
  ));
  const [created] = await db.insert(userSubjectImages).values({
    userKey,
    subjectId,
    thumbnail: image.thumbnail,
    sourceUrl: image.sourceUrl,
    imageHash: image.imageHash,
    sortOrder: existing.length,
    isCover: makeCover,
    width: image.width,
    height: image.height,
    mime: image.mime,
    createdAt: now,
    updatedAt: now,
  }).returning();
  if (!created) throw new Error("添加画廊图片失败");
  if (makeCover) await db.update(userSubjects).set({ thumbnail: created.thumbnail, updatedAt: now }).where(and(
    eq(userSubjects.id, subjectId),
    eq(userSubjects.userKey, userKey),
    eq(userSubjects.type, "visual"),
  ));
  return { image: created, images: [...existing.map((row) => ({ ...row, isCover: makeCover ? false : row.isCover })), created], duplicate: false };
}

export async function removeGalleryImage(db: Database, userKey: string, imageId: number) {
  const [existing] = await db.select().from(userSubjectImages).where(and(
    eq(userSubjectImages.id, imageId),
    eq(userSubjectImages.userKey, userKey),
  )).limit(1);
  if (!existing) return null;
  await db.delete(userSubjectImages).where(and(eq(userSubjectImages.id, imageId), eq(userSubjectImages.userKey, userKey)));
  const remaining = await galleryImagesForSubject(db, userKey, existing.subjectId);
  const currentCover = remaining.findIndex((row) => row.isCover);
  const coverIndex = currentCover >= 0 ? currentCover : remaining.length ? 0 : -1;
  const now = new Date();
  const normalized = remaining.map((row, index) => ({ ...row, sortOrder: index, isCover: index === coverIndex, updatedAt: now }));
  for (const row of normalized) {
    if (row.sortOrder !== remaining.find((candidate) => candidate.id === row.id)?.sortOrder || row.isCover !== Boolean(remaining.find((candidate) => candidate.id === row.id)?.isCover)) {
      await db.update(userSubjectImages).set({ sortOrder: row.sortOrder, isCover: row.isCover, updatedAt: now }).where(and(
        eq(userSubjectImages.id, row.id),
        eq(userSubjectImages.userKey, userKey),
      ));
    }
  }
  const cover = normalized.find((row) => row.isCover)?.thumbnail || normalized[0]?.thumbnail || "";
  await db.update(userSubjects).set({ thumbnail: cover, updatedAt: new Date() }).where(and(
    eq(userSubjects.id, existing.subjectId),
    eq(userSubjects.userKey, userKey),
    eq(userSubjects.type, "visual"),
  ));
  await removeUnusedAssets(db, userKey, [existing.thumbnail]);
  return { subjectId: existing.subjectId, images: normalized };
}

export async function deleteGalleryImagesForSubjects(db: Database, userKey: string, subjectIds: number[]) {
  const ids = normalizeGallerySubjectIds(subjectIds);
  if (!ids.length) return [];
  const grouped = await galleryImagesBySubjectIds(db, userKey, ids);
  const rows = Array.from(grouped.values()).flat();
  if (rows.length) {
    await queryGalleryImageBatches(ids, async (batchIds) => {
      await db.delete(userSubjectImages).where(and(
        eq(userSubjectImages.userKey, userKey),
        inArray(userSubjectImages.subjectId, batchIds),
      ));
      return [];
    });
  }
  return rows.map((row) => row.thumbnail);
}

export async function cleanupDeletedGalleryAssets(db: Database, userKey: string, urls: string[]) {
  await removeUnusedAssets(db, userKey, urls);
}

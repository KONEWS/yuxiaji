import { and, asc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { getDb } from "../../db";
import { agentOperations, userSubjectImages, userSubjects } from "../../db/schema";
import { mediaAssetExists } from "./media-storage";

export type UploadDuplicate = { existingId: number | null; existingImageId?: number; existingAssetId?: number; image: string };

/** Exact source-byte matches, shared across agents but always scoped to the owner.
 * Old successful upload receipts retain hashes even when cover metadata does not.
 * Join covers to their current URL so replaced covers are not treated as current.
 */
export async function findUploadDuplicate(userKey: string, hash: string, targetId: number | null): Promise<UploadDuplicate | null> {
  const db = getDb();
  const receipt = sql`CASE WHEN json_valid(${agentOperations.responseJson}) THEN ${agentOperations.responseJson} ELSE '{}' END`;
  const receiptImage = sql<string>`coalesce(json_extract(${receipt}, '$.image'), json_extract(${receipt}, '$.thumbnailUrl'))`;
  const operationScope = and(
    eq(agentOperations.userKey, userKey), inArray(agentOperations.resource, ["music_cover", "gallery_asset"]),
    eq(agentOperations.action, "upload"), gte(agentOperations.statusCode, 200), lt(agentOperations.statusCode, 300),
    sql`json_extract(${receipt}, '$.imageHash') = ${hash}`,
  );
  const [galleries, covers] = await Promise.all([
    db.select({ existingId: userSubjectImages.subjectId, existingImageId: userSubjectImages.id, image: userSubjectImages.thumbnail })
      .from(userSubjectImages).innerJoin(userSubjects, and(eq(userSubjects.id, userSubjectImages.subjectId), eq(userSubjects.userKey, userKey), eq(userSubjects.type, "visual")))
      .where(and(eq(userSubjectImages.userKey, userKey), eq(userSubjectImages.imageHash, hash)))
      .orderBy(sql`CASE WHEN ${userSubjectImages.subjectId} = ${targetId} THEN 0 ELSE 1 END`, asc(userSubjectImages.id)),
    db.selectDistinct({ existingId: userSubjects.id, image: userSubjects.image }).from(agentOperations)
      .innerJoin(userSubjects, and(eq(userSubjects.userKey, userKey), eq(userSubjects.image, receiptImage)))
      .where(operationScope).orderBy(sql`CASE WHEN ${userSubjects.id} = ${targetId} THEN 0 ELSE 1 END`, asc(userSubjects.id)),
  ]);
  const matches = [...galleries, ...covers.filter((row): row is { existingId: number; image: string } => Boolean(row.image))];
  matches.sort((a, b) => Number(b.existingId === targetId) - Number(a.existingId === targetId));
  for (const match of matches) {
    if (await mediaAssetExists(match.image, userKey)) return match;
  }
  // Standalone uploads can exist before an Agent creates/attaches a gallery.
  // Check object existence: stale receipts must not resurrect deleted assets.
  const standalone = await db.selectDistinct({ image: receiptImage })
    .from(agentOperations).where(and(operationScope, eq(agentOperations.resource, "gallery_asset")))
    .orderBy(receiptImage);
  for (const match of standalone) {
    if (await mediaAssetExists(match.image, userKey)) {
      const version = new URL(match.image, "https://local.invalid").searchParams.get("v");
      return { ...match, existingId: null, ...(version && /^\d+$/.test(version) ? { existingAssetId: Number(version) } : {}) };
    }
  }
  return null;
}

export function duplicateUploadWarning(match: UploadDuplicate, skipped: boolean) {
  return {
    duplicate: true,
    skipped,
    warnings: [{
      code: "duplicate_file",
      message: skipped ? "检测到相同文件，已跳过重复保存并保留现有图片。" : "检测到其他位置已上传相同文件，本次仍按指定目标保存；请核对是否需要。",
      match: "sha256",
      ...(match.existingId ? { existingId: match.existingId } : {}),
      ...(match.existingImageId ? { existingImageId: match.existingImageId } : {}),
      ...(match.existingAssetId ? { existingAssetId: match.existingAssetId } : {}),
    }],
  };
}

import { env } from "cloudflare:workers";
import { and, eq, getTableColumns, getTableName, sql } from "drizzle-orm";
import { getDb } from "../../db";
import { userSubjectImages, userSubjects } from "../../db/schema";
import type { GalleryImageRow } from "./gallery-images";

const subjectColumns = getTableColumns(userSubjects);
const imageColumns = getTableColumns(userSubjectImages);
// Drizzle strips Column qualifiers inside a single-table SELECT projection.
// This correlated subquery must retain them: a bare `id` would bind to the
// image row instead of the outer subject. Identifiers come only from schema.
const quoteIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const subjectColumn = (name: string) => sql.raw(`${quoteIdentifier(getTableName(userSubjects))}.${quoteIdentifier(name)}`);
const imageColumn = (name: string) => sql.raw(`${quoteIdentifier(getTableName(userSubjectImages))}.${quoteIdentifier(name)}`);

// One SQLite expression captures the row and its ordered image rows in the
// same read snapshot. Neither timestamps nor a second SELECT can identify
// concurrent edits reliably (including two edits within the same millisecond).
export const mediaSnapshot = sql<string>`json_array(
  ${sql.join(Object.values(subjectColumns).map((column) => subjectColumn(column.name)), sql`, `)},
  json(coalesce((SELECT json_group_array(json(image_value)) FROM (
    SELECT json_array(${sql.join(Object.values(imageColumns).map((column) => imageColumn(column.name)), sql`, `)}) AS image_value
    FROM ${userSubjectImages}
    WHERE ${imageColumn(userSubjectImages.subjectId.name)} = ${subjectColumn(userSubjects.id.name)}
      AND ${imageColumn(userSubjectImages.userKey.name)} = ${subjectColumn(userSubjects.userKey.name)}
    ORDER BY ${imageColumn(userSubjectImages.sortOrder.name)}, ${imageColumn(userSubjectImages.id.name)}
  )), '[]'))
)`;

export const mediaSnapshotSelection = { ...subjectColumns, snapshot: mediaSnapshot };

export function snapshotGalleryImages(snapshot: string): GalleryImageRow[] {
  const values: unknown[] = JSON.parse(snapshot);
  const images = values[values.length - 1] as unknown[][];
  return images.map((row) => Object.fromEntries(Object.entries(imageColumns).map(([key, column], index) => [
    key, row[index] === null ? null : column.mapFromDriverValue(row[index] as never),
  ])) as GalleryImageRow);
}

export async function mediaRevision(snapshot: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(snapshot));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type MediaWriteQuery = { toSQL(): { sql: string; params: unknown[] } };

export class MediaConflictError extends Error {
  constructor() { super("此收藏已在其他页面或 AI 中更新，请重新读取最新内容后再保存。"); }
}

/** D1 batches are transactions: a failed guard rolls back every following write. */
export async function writeMediaSnapshot(db: ReturnType<typeof getDb>, userKey: string, id: number, snapshot: string, writes: MediaWriteQuery[]) {
  const current = db.select({ snapshot: mediaSnapshot }).from(userSubjects).where(and(
    eq(userSubjects.id, id), eq(userSubjects.userKey, userKey),
  )).toSQL();
  const guard = env.DB.prepare(`SELECT CASE WHEN (${current.sql}) = ? THEN 1 ELSE json('media_write_conflict') END`).bind(...current.params, snapshot);
  const statements = writes.map((query) => {
    const compiled = query.toSQL();
    return env.DB.prepare(compiled.sql).bind(...compiled.params);
  });
  try {
    await env.DB.batch([guard, ...statements]);
  } catch (error) {
    // Only the guard invokes JSON on a literal. Values in mutation statements
    // are parameterized, so malformed JSON here means the snapshot changed.
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("malformed JSON")) throw new MediaConflictError();
    throw error;
  }
}

import type { MediaMetadata } from "./constants";
import type { Anime, CalendarEntry } from "./tracker-types";

type CalendarIdentity = Pick<CalendarEntry, "source" | "subjectId" | "sourceIds" | "title" | "jp">;
type CollectionIdentity = Pick<Anime, "source" | "subjectId" | "metadata" | "title" | "jp" | "tags" | "mediaType">;

export function calendarSourceTokens(source: string) {
  return source.split("+").map((value) => value.trim().toLowerCase()).filter(Boolean)
    .map((value) => value === "anime schedule" ? "animeschedule" : value);
}

/** Find an existing collection even when its calendar tracking is disabled. */
export function calendarEntryMatches(item: CollectionIdentity, entry: CalendarIdentity) {
  if (item.mediaType && item.mediaType !== "anime") return false;
  const providers = calendarSourceTokens(entry.source);
  const sourceIds = { ...(entry.sourceIds || {}) };
  if (entry.subjectId && providers.length === 1) sourceIds[providers[0]] ||= String(entry.subjectId);
  if (entry.subjectId && providers.includes("bangumi")) sourceIds.bangumi ||= String(entry.subjectId);
  let comparableId = false;
  for (const provider of providers) {
    const expected = sourceIds[provider];
    if (!expected) continue;
    const actual = item.metadata?.sources?.[provider]
      || (item.source === provider && item.subjectId ? String(item.subjectId) : "");
    if (!actual) continue;
    comparableId = true;
    if (String(actual) === String(expected)) return true;
  }
  // Title matching is reserved for legacy calendar entries without a shared
  // source ID. An unrelated manual item or a known ID mismatch is not a match.
  return !comparableId && item.tags.some((tag) => tag.trim() === "放送追更")
    && (item.title === entry.title || Boolean(item.jp && entry.jp && item.jp === entry.jp));
}

export function isTrackedCalendarEntry(entry: CalendarIdentity, anime: readonly CollectionIdentity[]) {
  return anime.some((item) => item.metadata?.calendarTracking !== false && calendarEntryMatches(item, entry));
}

/** Toggle only calendar participation, retaining notes, progress and assets. */
export function setCalendarTracking<T extends { metadata: MediaMetadata }>(item: T, tracked: boolean): T {
  return { ...item, metadata: { ...item.metadata, calendarTracking: tracked } };
}

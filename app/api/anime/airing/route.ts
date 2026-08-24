import { and, asc, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { animeAiringSchedule, userSubjects } from "../../../../db/schema";
import { getCurrentUser } from "../../../lib/current-user";
import { formatWeekday, nextAirAtForStoredSchedule } from "../../../lib/anime-airing-time";
import { currentAiringSeason } from "../../../lib/anime-airing";
import { getBangumiSubject, subjectImage } from "../../../lib/bangumi-api";
import { requireAdminSession } from "../../../lib/admin-auth";

function asNumber(value: string | null, fallback: number | null = null) {
  const number = Number(value);
  return Number.isInteger(number) ? number : fallback;
}

function normalizeSeason(value: string | null) {
  const aliases: Record<string, string> = { 冬: "winter", 春: "spring", 夏: "summer", 秋: "fall", winter: "winter", spring: "spring", summer: "summer", fall: "fall", autumn: "fall" };
  return value ? aliases[value.trim().toLowerCase()] || "" : "";
}

function normalizeWeekday(value: string | null) {
  if (!value) return null;
  if (/^[1-7]$/.test(value)) return Number(value);
  const normalized = value.trim().toLowerCase().replace(/^星期|^周/, "");
  return ({ 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, mon: 1, monday: 1, tue: 2, tuesday: 2, wed: 3, wednesday: 3, thu: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6, sun: 7, sunday: 7 } as Record<string, number>)[normalized] || null;
}

function asMillis(value: Date | number | null) {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.getTime() : Number(value);
}

type AiringRow = typeof animeAiringSchedule.$inferSelect;

async function hydrateFallbackTitles(rows: AiringRow[]) {
  const candidates = rows.filter((row) => row.source.includes("bangumi") && /^Bangumi #\d+$/.test(row.title));
  if (!candidates.length) return rows;
  const resolved = new Map<number, { title: string; jpTitle: string; image: string; summary: string }>();
  for (let offset = 0; offset < candidates.length; offset += 4) {
    const batch = candidates.slice(offset, offset + 4);
    const results = await Promise.all(batch.map(async (row) => {
      try {
        const detail = await getBangumiSubject(row.subjectId);
        const title = String(detail.name_cn || detail.name || "").trim();
        const jpTitle = String(detail.name || "").trim();
        if (!title && !jpTitle) return null;
        return { id: row.subjectId, title: title || jpTitle, jpTitle: jpTitle || title, image: subjectImage(detail), summary: String(detail.summary || "").trim() };
      } catch {
        return null;
      }
    }));
    for (const result of results) if (result) resolved.set(result.id, result);
  }
  return rows.map((row) => {
    const detail = resolved.get(row.subjectId);
    if (!detail) return row;
    let metadata: Record<string, unknown> = {};
    try { metadata = JSON.parse(row.metadata) as Record<string, unknown>; } catch { /* preserve malformed legacy metadata */ }
    if (!metadata.summary && detail.summary) metadata.summary = detail.summary;
    if (!metadata.images && detail.image) metadata.images = { large: detail.image };
    return { ...row, title: detail.title, jpTitle: detail.jpTitle, metadata: JSON.stringify(metadata) };
  });
}

function titleKey(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function mergeRows(rows: AiringRow[]) {
  const priority: Record<string, number> = { bangumi: 1, anilist: 2, animeschedule: 3, custom: 4 };
  const groups: Array<{ row: AiringRow; providers: Set<string>; metadata: Record<string, unknown>; keys: Set<string> }> = [];
  const aliases = new Map<string, number>();
  const sorted = [...rows].sort((a, b) => (priority[a.source] || 0) - (priority[b.source] || 0));
  for (const row of sorted) {
    let metadata: Record<string, unknown> = {};
    try { metadata = JSON.parse(row.metadata) as Record<string, unknown>; } catch { /* isolate malformed metadata */ }
    const keys = new Set([titleKey(row.title), titleKey(row.jpTitle)].filter(Boolean));
    let groupIndex = -1;
    if (row.source === "custom") {
      groupIndex = groups.findIndex((group) => group.row.subjectId === row.subjectId);
    }
    if (groupIndex < 0) {
      for (const key of keys) {
        const match = aliases.get(key);
        if (match !== undefined) { groupIndex = match; break; }
      }
    }
    if (groupIndex < 0) {
      const group = { row, providers: new Set([row.source]), metadata, keys };
      groups.push(group);
      const index = groups.length - 1;
      keys.forEach((key) => aliases.set(key, index));
      continue;
    }
    const group = groups[groupIndex];
    const baseSubjectId = group.providers.has("bangumi") ? group.row.subjectId : row.source === "bangumi" ? row.subjectId : group.row.subjectId;
    const hasBangumiTitle = group.providers.has("bangumi") || row.source === "bangumi";
    group.providers.add(row.source);
    group.keys = new Set([...group.keys, ...keys]);
    group.keys.forEach((key) => aliases.set(key, groupIndex));
    group.metadata = { ...group.metadata, ...metadata, providers: Array.from(group.providers), sourceIds: { ...(group.metadata.sourceIds as Record<string, unknown> || {}), [row.source]: row.subjectId }, ...(row.source === "custom" ? { customScheduleId: row.id } : {}) };
    group.row = {
      ...group.row,
      id: row.source === "custom" ? row.id : group.row.id,
      subjectId: baseSubjectId,
      // Bangumi is the canonical Chinese-title source. AniList and
      // AnimeSchedule enrich the same row with airing data without replacing
      // a title that Bangumi already supplied.
      title: hasBangumiTitle ? (row.source === "bangumi" ? row.title || group.row.title : group.row.title) : row.title || group.row.title,
      jpTitle: hasBangumiTitle ? (row.source === "bangumi" ? row.jpTitle || group.row.jpTitle : group.row.jpTitle) : row.jpTitle || group.row.jpTitle,
      weekday: row.weekday || group.row.weekday,
      airTime: row.airTime || group.row.airTime,
      nextEpisode: row.nextEpisode ?? group.row.nextEpisode,
      nextAirAt: row.nextAirAt ?? group.row.nextAirAt,
      source: Array.from(group.providers).join("+"),
      metadata: JSON.stringify(group.metadata),
      lastChecked: row.lastChecked > group.row.lastChecked ? row.lastChecked : group.row.lastChecked,
      updatedAt: row.updatedAt > group.row.updatedAt ? row.updatedAt : group.row.updatedAt,
    };
  }
  return groups.map((group) => {
    const metadata = { ...group.metadata, providers: Array.from(group.providers) };
    return { ...group.row, source: Array.from(group.providers).join("+"), metadata: JSON.stringify(metadata) };
  });
}

export async function GET(request: Request) {
  const current = await requireAdminSession(request);
  if (current instanceof Response) return current;
  try {
    const url = new URL(request.url);
    const defaults = currentAiringSeason();
    const season = normalizeSeason(url.searchParams.get("season")) || defaults.season;
    const year = asNumber(url.searchParams.get("year"), defaults.year) || defaults.year;
    const weekday = normalizeWeekday(url.searchParams.get("weekday"));
    const source = url.searchParams.get("source")?.trim().toLowerCase() || "";
    const conditions = [eq(animeAiringSchedule.season, season), eq(animeAiringSchedule.year, year)];
    if (source && source !== "all") conditions.push(eq(animeAiringSchedule.source, source));
    if (weekday) conditions.push(eq(animeAiringSchedule.weekday, weekday));
    const selectedRows = await getDb().select().from(animeAiringSchedule).where(and(...conditions)).orderBy(asc(animeAiringSchedule.weekday), asc(animeAiringSchedule.nextAirAt), asc(animeAiringSchedule.title));
    const hydratedRows = await hydrateFallbackTitles(selectedRows);
    const rows = source && source !== "all" ? hydratedRows : mergeRows(hydratedRows);
    const key = getCurrentUser(request);
    const subjectIds = Array.from(new Set(rows.map((row) => row.subjectId).filter((id) => Number.isInteger(id) && id > 0)));
    // Query the user's anime collection using the two stable ownership fields,
    // then match subject ids in memory. This avoids the large dynamic IN clause
    // that has produced unreliable D1 queries in the Worker runtime while
    // keeping the join semantics explicit and aligned with the schema.
    const collectionRows = await getDb().select({
      id: userSubjects.id,
      subjectId: userSubjects.subjectId,
      title: userSubjects.title,
      progress: userSubjects.progress,
    }).from(userSubjects).where(and(
      eq(userSubjects.userKey, key),
      eq(userSubjects.type, "anime"),
    ));
    const subjectIdSet = new Set(subjectIds);
    const collected = collectionRows.filter((item) => item.subjectId !== null && subjectIdSet.has(item.subjectId));
    const collectedBySubject = new Map<number, typeof collected[number]>();
    collected.forEach((item) => { if (item.subjectId && !collectedBySubject.has(item.subjectId)) collectedBySubject.set(item.subjectId, item); });
    return Response.json({
      season,
      year,
      timezone: "Asia/Tokyo",
      sources: ["bangumi", "anilist", "animeschedule", "custom"],
      schedules: rows.map((row) => {
        let metadata: Record<string, unknown> = {};
        try { metadata = JSON.parse(row.metadata) as Record<string, unknown>; } catch { /* keep malformed legacy metadata isolated */ }
        const media = collectedBySubject.get(row.subjectId);
        return {
          id: row.id,
          subjectId: row.subjectId,
          title: row.title,
          jpTitle: row.jpTitle,
          weekday: row.weekday,
          weekdayLabel: `星期${formatWeekday(row.weekday)}`,
          airTime: row.airTime,
          timezone: row.timezone,
          nextEpisode: row.nextEpisode ?? (media && media.progress >= 0 ? media.progress + 1 : null),
          nextAirAt: (row.source.includes("anilist") || row.source.includes("animeschedule") || row.source.includes("custom")) && asMillis(row.nextAirAt)
            ? new Date(asMillis(row.nextAirAt)!).toISOString()
            : row.airTime
              ? nextAirAtForStoredSchedule({ weekday: row.weekday, airTime: row.airTime, now: new Date() })?.toISOString() || null
              : (asMillis(row.nextAirAt) ? new Date(asMillis(row.nextAirAt)!).toISOString() : null),
          season: row.season,
          year: row.year,
          source: row.source,
          metadata,
          lastChecked: asMillis(row.lastChecked) ? new Date(asMillis(row.lastChecked)!).toISOString() : null,
          isCollected: Boolean(media),
          mediaId: media?.id ?? null,
          mediaTitle: media?.title ?? null,
        };
      }),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ error: "读取放送计划失败", details: error instanceof Error ? error.message : String(error) }, { status: 500, headers: { "cache-control": "no-store" } });
  }
}

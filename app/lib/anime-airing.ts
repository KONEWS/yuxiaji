import { getTokyoCalendarParts, nextAirAtForSchedule, normalizeJapaneseAirTime, seasonForMonth } from "./anime-airing-time";
import { getBangumiSubject, subjectImage } from "./bangumi-api";
import { getAnimeScheduleCredential } from "./integration-credentials";

export const AIRING_TIMEZONE = "Asia/Tokyo";
export const AIRING_SOURCE = "bangumi";
export const ANILIST_AIRING_SOURCE = "anilist";
export const ANIMESCHEDULE_AIRING_SOURCE = "animeschedule";
export const CUSTOM_AIRING_SOURCE = "custom";

export type AiringSchedule = {
  subjectId: number;
  title: string;
  jpTitle: string;
  weekday: number;
  airTime: string;
  timezone: string;
  nextEpisode: number | null;
  nextAirAt: Date | null;
  season: string;
  year: number;
  source: string;
  metadata: Record<string, unknown>;
};

export type AiringProvider = {
  name: string;
  fetchSchedules(input: {
    season: string;
    year: number;
    signal?: AbortSignal;
    onProgress?: (progress: number, stage: "requesting" | "parsing") => void;
  }): Promise<AiringSchedule[]>;
};

type AniListAiringNode = { airingAt?: number | null; episode?: number | null };
type AniListMedia = {
  id?: number;
  idMal?: number | null;
  title?: { romaji?: string | null; english?: string | null; native?: string | null; userPreferred?: string | null } | null;
  episodes?: number | null;
  coverImage?: { large?: string | null; medium?: string | null } | null;
  airingSchedule?: { nodes?: AniListAiringNode[] | null } | null;
};

type BangumiCalendarItem = Record<string, unknown>;
type AnimeScheduleTimetableItem = {
  id?: string | number | null;
  title?: string | null;
  route?: string | null;
  romaji?: string | null;
  english?: string | null;
  native?: string | null;
  episodeDate?: string | null;
  episodeNumber?: number | null;
  episodes?: number | null;
  airType?: string | null;
  status?: string | null;
  imageVersionRoute?: string | null;
};

const WEEKDAY_NAMES: Record<string, number> = {
  mon: 1, monday: 1, "星期一": 1, "周一": 1, 一: 1, 月: 1,
  tue: 2, tuesday: 2, "星期二": 2, "周二": 2, 二: 2, 火: 2,
  wed: 3, wednesday: 3, "星期三": 3, "周三": 3, 三: 3, 水: 3,
  thu: 4, thursday: 4, "星期四": 4, "周四": 4, 四: 4, 木: 4,
  fri: 5, friday: 5, "星期五": 5, "周五": 5, 五: 5, 金: 5,
  sat: 6, saturday: 6, "星期六": 6, "周六": 6, 六: 6, 土: 6,
  sun: 7, sunday: 7, "星期日": 7, "周日": 7, 日: 7,
};

function numberValue(value: unknown) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function itemWeekday(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 7) return value;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return itemWeekday(record.id ?? record.weekday ?? record.cn ?? record.en ?? record.ja);
  }
  const normalized = stringValue(value).toLowerCase();
  if (/^[1-7]$/.test(normalized)) return Number(normalized);
  for (const [name, day] of Object.entries(WEEKDAY_NAMES)) if (normalized.includes(name)) return day;
  return null;
}

function itemAirTime(item: BangumiCalendarItem) {
  const metadata = item.metadata && typeof item.metadata === "object" ? item.metadata as Record<string, unknown> : undefined;
  return stringValue(item.air_time ?? item.airtime ?? item.broadcast_time ?? item.broadcastTime ?? item.time ?? metadata?.airTime);
}

function itemNextEpisode(item: BangumiCalendarItem) {
  const explicit = numberValue(item.next_episode ?? item.nextEpisode ?? item.episode ?? item.ep);
  if (explicit) return explicit;
  const aired = numberValue(item.ep_status ?? item.epStatus);
  return aired ? aired + 1 : null;
}

function parseDate(value: unknown) {
  const text = stringValue(value);
  const match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  return match ? { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) } : null;
}

function extractItems(payload: unknown) {
  if (!Array.isArray(payload)) return [] as Array<{ item: BangumiCalendarItem; weekday: number | null }>;
  const rows: Array<{ item: BangumiCalendarItem; weekday: number | null }> = [];
  for (const group of payload) {
    if (!group || typeof group !== "object") continue;
    const record = group as Record<string, unknown>;
    const groupDay = itemWeekday(record.weekday ?? record.day ?? record.week);
    const items = Array.isArray(record.items) ? record.items : Array.isArray(record.subjects) ? record.subjects : [];
    for (const rawItem of items) if (rawItem && typeof rawItem === "object") rows.push({ item: rawItem as BangumiCalendarItem, weekday: groupDay });
  }
  return rows;
}

export function parseBangumiCalendar(payload: unknown, season: string, year: number, now = new Date()): AiringSchedule[] {
  const schedules: AiringSchedule[] = [];
  for (const { item, weekday: groupDay } of extractItems(payload)) {
    const subjectId = numberValue(item.id ?? item.subject_id);
    if (!subjectId) continue;
    const date = parseDate(item.air_date ?? item.airDate ?? item.first_air_date);
    const rawTime = itemAirTime(item);
    const timeParts = rawTime.match(/^(\d{1,2})(?::(\d{2}))?/);
    const baseDay = itemWeekday(item.air_weekday ?? item.airWeekday ?? item.weekday) || groupDay || (date ? getTokyoCalendarParts(new Date(Date.UTC(date.year, date.month - 1, date.day))).weekday : null) || 1;
    const dayOffset = timeParts ? Math.floor(Number(timeParts[1]) / 24) : 0;
    const weekday = ((baseDay - 1 + dayOffset) % 7) + 1;
    const airTime = rawTime ? normalizeJapaneseAirTime(rawTime) : "";
    const nextAirAt = airTime ? nextAirAtForSchedule({ weekday: baseDay, airTime: rawTime, now }) : null;
    // Some Bangumi rows include an empty `name_cn` while `name` is valid.
    // Nullish coalescing would stop at the empty string and produce an ID-only
    // title, so choose the first non-empty field explicitly.
    const title = stringValue(item.name_cn) || stringValue(item.title) || stringValue(item.name) || `Bangumi #${subjectId}`;
    const jpTitle = stringValue(item.name) || stringValue(item.original_name) || stringValue(item.jp_title);
    const metadata: Record<string, unknown> = {
      summary: stringValue(item.summary),
      airDate: date ? `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}` : "",
      totalEpisodes: numberValue(item.eps ?? item.total_episodes),
      images: item.images && typeof item.images === "object" ? item.images : undefined,
    };
    schedules.push({ subjectId, title, jpTitle, weekday, airTime, timezone: AIRING_TIMEZONE, nextEpisode: itemNextEpisode(item), nextAirAt, season, year, source: AIRING_SOURCE, metadata });
  }
  return Array.from(new Map(schedules.map((item) => [`${item.source}:${item.subjectId}:${item.season}:${item.year}`, item])).values());
}

/**
 * Bangumi's calendar normally contains names, but newly indexed subjects can
 * briefly arrive with only an id. Resolve those sparse rows before persisting
 * them so the calendar never permanently displays "Bangumi #<id>".
 */
async function hydrateBangumiScheduleNames(schedules: AiringSchedule[], signal?: AbortSignal) {
  const candidates = schedules.filter((item) => !item.title.trim() || /^Bangumi #\d+$/.test(item.title));
  if (!candidates.length) return schedules;
  const resolved = new Map<number, { title: string; jpTitle: string; image: string; summary: string }>();
  for (let offset = 0; offset < candidates.length; offset += 4) {
    const batch = candidates.slice(offset, offset + 4);
    const results = await Promise.all(batch.map(async (item) => {
      try {
        const detail = await getBangumiSubject(item.subjectId, { signal });
        const title = String(detail.name_cn || detail.name || "").trim();
        const jpTitle = String(detail.name || "").trim();
        if (!title && !jpTitle) return null;
        return {
          id: item.subjectId,
          title: title || jpTitle,
          jpTitle: jpTitle || title,
          image: subjectImage(detail),
          summary: String(detail.summary || "").trim(),
        };
      } catch {
        return null;
      }
    }));
    for (const result of results) if (result) resolved.set(result.id, result);
  }
  if (!resolved.size) return schedules;
  return schedules.map((item) => {
    const detail = resolved.get(item.subjectId);
    if (!detail) return item;
    const metadata = { ...item.metadata };
    if (!metadata.summary && detail.summary) metadata.summary = detail.summary;
    if (!metadata.images && detail.image) metadata.images = { large: detail.image };
    return { ...item, title: detail.title, jpTitle: detail.jpTitle, metadata };
  });
}

export const bangumiAiringProvider: AiringProvider = {
  name: AIRING_SOURCE,
  async fetchSchedules({ season, year, signal, onProgress }) {
    let response: Response;
    try {
      // Keep the request limited to standard Worker-compatible headers. This
      // also avoids relying on runtime-specific browser header behavior.
      onProgress?.(20, "requesting");
      const request = new Request("https://api.bgm.tv/calendar", {
        headers: { accept: "application/json", "user-agent": "jlHKO/yuexiaji/0.1.0" },
        ...(signal ? { signal } : {}),
      });
      try {
        response = await fetch(request);
      } catch (firstError) {
        // A transient upstream connection error should not make a manual
        // sync fail immediately. Retry once with a fresh Request object so a
        // consumed/aborted request cannot be reused by the Worker runtime.
        try {
          response = await fetch(new Request(request));
        } catch {
          throw firstError;
        }
      }
    } catch (error) {
      throw new Error(`Bangumi 放送日历请求失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) throw new Error(`Bangumi 放送日历返回 HTTP ${response.status}`);
    try {
      const payload = await response.json() as unknown;
      onProgress?.(45, "parsing");
      const schedules = await hydrateBangumiScheduleNames(parseBangumiCalendar(payload, season, year, new Date()), signal);
      if (!schedules.length) throw new Error("响应中没有可识别的番剧条目");
      return schedules;
    } catch (error) {
      throw new Error(`Bangumi 放送日历响应无效：${error instanceof Error ? error.message : String(error)}`);
    }
  },
};

function anilistSeason(value: string) {
  return ({ winter: "WINTER", spring: "SPRING", summer: "SUMMER", fall: "FALL" } as Record<string, string>)[value] || "SUMMER";
}

function anilistTime(timestamp: number) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: AIRING_TIMEZONE, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(timestamp * 1000));
  const value = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return `${value("hour")}:${value("minute")}`;
}

export function parseAniListAiring(payload: unknown, season: string, year: number, now = new Date()): AiringSchedule[] {
  const data = payload && typeof payload === "object" ? (payload as { data?: { Page?: { media?: AniListMedia[] } } }).data : undefined;
  const media = Array.isArray(data?.Page?.media) ? data.Page.media : [];
  const schedules: AiringSchedule[] = [];
  for (const item of media) {
    const subjectId = numberValue(item.id);
    const next = Array.isArray(item.airingSchedule?.nodes) ? item.airingSchedule!.nodes!.find((node) => Number(node.airingAt) > Math.floor(now.getTime() / 1000)) : null;
    if (!subjectId || !next?.airingAt) continue;
    const nextDate = new Date(next.airingAt * 1000);
    const tokyo = getTokyoCalendarParts(nextDate);
    const title = stringValue(item.title?.english) || stringValue(item.title?.romaji) || stringValue(item.title?.userPreferred) || stringValue(item.title?.native) || `AniList #${subjectId}`;
    const jpTitle = stringValue(item.title?.native) || stringValue(item.title?.romaji) || stringValue(item.title?.userPreferred);
    const cover = stringValue(item.coverImage?.large ?? item.coverImage?.medium);
    schedules.push({
      subjectId,
      title,
      jpTitle,
      weekday: tokyo.weekday,
      airTime: anilistTime(next.airingAt),
      timezone: AIRING_TIMEZONE,
      nextEpisode: numberValue(next.episode),
      nextAirAt: nextDate,
      season,
      year,
      source: ANILIST_AIRING_SOURCE,
      metadata: {
        provider: ANILIST_AIRING_SOURCE,
        anilistId: subjectId,
        malId: numberValue(item.idMal),
        totalEpisodes: numberValue(item.episodes),
        airDate: `${tokyo.year}-${String(tokyo.month).padStart(2, "0")}-${String(tokyo.day).padStart(2, "0")}`,
        images: cover ? { large: cover } : undefined,
      },
    });
  }
  return Array.from(new Map(schedules.map((item) => [`${item.source}:${item.subjectId}:${item.season}:${item.year}`, item])).values());
}

export const anilistAiringProvider: AiringProvider = {
  name: ANILIST_AIRING_SOURCE,
  async fetchSchedules({ season, year, signal, onProgress }) {
    const query = `query($season: MediaSeason!, $seasonYear: Int!, $page: Int!, $perPage: Int!) { Page(page: $page, perPage: $perPage) { pageInfo { hasNextPage } media(type: ANIME, season: $season, seasonYear: $seasonYear, status: RELEASING, sort: POPULARITY_DESC) { id idMal title { romaji english native userPreferred } episodes coverImage { large medium } airingSchedule(notYetAired: true, perPage: 2) { nodes { airingAt episode } } } } }`;
    const allMedia: AniListMedia[] = [];
    try {
      for (let page = 1; page <= 10; page += 1) {
        onProgress?.(Math.min(42, 20 + page * 3), "requesting");
        const response = await fetch("https://graphql.anilist.co", {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json", "user-agent": "jlHKO/yuexiaji/0.1.0" },
          body: JSON.stringify({ query, variables: { season: anilistSeason(season), seasonYear: year, page, perPage: 50 } }),
          ...(signal ? { signal } : {}),
        });
        if (!response.ok) throw new Error(`AniList 放送接口返回 HTTP ${response.status}`);
        const payload = await response.json() as { errors?: Array<{ message?: string }>; data?: { Page?: { media?: AniListMedia[]; pageInfo?: { hasNextPage?: boolean } } } };
        if (payload.errors?.length) throw new Error(payload.errors.map((item) => item.message || "GraphQL error").join("；"));
        const pageData = payload.data?.Page;
        const media = Array.isArray(pageData?.media) ? pageData.media : [];
        allMedia.push(...media);
        if (!pageData?.pageInfo?.hasNextPage || media.length === 0) break;
      }
    } catch (error) {
      throw new Error(`AniList 放送请求失败：${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      onProgress?.(45, "parsing");
      const schedules = parseAniListAiring({ data: { Page: { media: allMedia } } }, season, year);
      if (!schedules.length) throw new Error("响应中没有可识别的在播番剧");
      return schedules;
    } catch (error) {
      throw new Error(`AniList 放送响应无效：${error instanceof Error ? error.message : String(error)}`);
    }
  },
};

function stableProviderId(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 1) || 1;
}

function animeScheduleItems(payload: unknown): AnimeScheduleTimetableItem[] {
  if (Array.isArray(payload)) return payload.filter((item): item is AnimeScheduleTimetableItem => Boolean(item && typeof item === "object"));
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  const rows = record.data ?? record.timetable ?? record.items;
  return Array.isArray(rows) ? rows.filter((item): item is AnimeScheduleTimetableItem => Boolean(item && typeof item === "object")) : [];
}

export function parseAnimeScheduleTimetable(payload: unknown, season: string, year: number, now = new Date()): AiringSchedule[] {
  const schedules: AiringSchedule[] = [];
  for (const item of animeScheduleItems(payload)) {
    const episodeDate = stringValue(item.episodeDate);
    const nextAirAt = episodeDate ? new Date(episodeDate) : null;
    if (!nextAirAt || !Number.isFinite(nextAirAt.getTime()) || nextAirAt.getTime() < now.getTime() - 24 * 60 * 60 * 1000) continue;
    const route = stringValue(item.route);
    const providerId = typeof item.id === "number" && Number.isFinite(item.id) ? String(item.id) : stringValue(item.id) || route;
    if (!providerId) continue;
    const tokyo = getTokyoCalendarParts(nextAirAt);
    const imageRoute = stringValue(item.imageVersionRoute);
    const title = stringValue(item.title ?? item.english ?? item.romaji ?? item.native) || `AnimeSchedule #${providerId}`;
    const jpTitle = stringValue(item.native ?? item.romaji);
    schedules.push({
      subjectId: stableProviderId(`animeschedule:${providerId}`),
      title,
      jpTitle,
      weekday: tokyo.weekday,
      airTime: anilistTime(Math.floor(nextAirAt.getTime() / 1000)),
      timezone: AIRING_TIMEZONE,
      nextEpisode: numberValue(item.episodeNumber),
      nextAirAt,
      season,
      year,
      source: ANIMESCHEDULE_AIRING_SOURCE,
      metadata: {
        provider: ANIMESCHEDULE_AIRING_SOURCE,
        animeScheduleId: providerId,
        route,
        airType: stringValue(item.airType),
        status: stringValue(item.status),
        totalEpisodes: numberValue(item.episodes),
        images: imageRoute ? { large: `https://img.animeschedule.net/production/assets/public/img/${imageRoute.replace(/^\/+/, "")}` } : undefined,
      },
    });
  }
  return Array.from(new Map(schedules.map((item) => [`${item.source}:${item.subjectId}:${item.season}:${item.year}`, item])).values());
}

export const animeScheduleAiringProvider: AiringProvider = {
  name: ANIMESCHEDULE_AIRING_SOURCE,
  async fetchSchedules({ season, year, signal, onProgress }) {
    const { token } = await getAnimeScheduleCredential();
    if (!token) throw new Error("AnimeSchedule 未配置：请在账户安全页面绑定 Application Token");
    let response: Response;
    try {
      onProgress?.(20, "requesting");
      response = await fetch("https://animeschedule.net/api/v3/timetables/raw?tz=Asia%2FTokyo", {
        headers: { accept: "application/json", authorization: `Bearer ${token}`, "user-agent": "jlHKO/yuexiaji/0.1.0" },
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw new Error(`AnimeSchedule 放送请求失败：${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status === 401 || response.status === 403) throw new Error("AnimeSchedule Token 无效或无权读取 timetable");
    if (!response.ok) throw new Error(`AnimeSchedule 放送接口返回 HTTP ${response.status}`);
    try {
      const payload = await response.json() as unknown;
      onProgress?.(45, "parsing");
      const schedules = parseAnimeScheduleTimetable(payload, season, year);
      if (!schedules.length) throw new Error("响应中没有可识别的本周放送条目");
      return schedules;
    } catch (error) {
      throw new Error(`AnimeSchedule 放送响应无效：${error instanceof Error ? error.message : String(error)}`);
    }
  },
};

/** Provider registry keeps the sync route independent from any one source. */
export const airingProviders: Record<string, AiringProvider> = {
  [bangumiAiringProvider.name]: bangumiAiringProvider,
  [anilistAiringProvider.name]: anilistAiringProvider,
  [animeScheduleAiringProvider.name]: animeScheduleAiringProvider,
};

export function getAiringProvider(name = AIRING_SOURCE) {
  return airingProviders[name] || null;
}

export function currentAiringSeason(date = new Date()) {
  const parts = getTokyoCalendarParts(date);
  return { season: seasonForMonth(parts.month), year: parts.year };
}

export { normalizeJapaneseAirTime, japaneseAirTimeOffset, nextAirAtForSchedule, nextAirAtForStoredSchedule, tokyoLocalToTimestamp } from "./anime-airing-time";

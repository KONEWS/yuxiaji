import { env } from "cloudflare:workers";
import { getDb } from "../../../db";
import { userDevices, userState, userSubjects } from "../../../db/schema";
import { getAnimeScheduleCredential } from "../../lib/integration-credentials";

type HealthService = {
  id: string;
  name: string;
  description: string;
  ok: boolean;
  latency: number;
  status?: "正常" | "异常" | "未配置";
};

async function check(id: string, name: string, description: string, run: () => Promise<void>): Promise<HealthService> {
  const started = Date.now();
  try {
    await run();
    return { id, name, description, ok: true, latency: Date.now() - started };
  } catch {
    return { id, name, description, ok: false, latency: Date.now() - started };
  }
}

function unconfigured(id: string, name: string, description: string): HealthService {
  return { id, name, description, ok: false, latency: 0, status: "未配置" };
}

export async function GET() {
  const animeSchedule = await getAnimeScheduleCredential().catch(() => ({ token: "", source: null, row: null }));
  const googleBooksKey = ((env as typeof env & { GOOGLE_BOOKS_API_KEY?: string }).GOOGLE_BOOKS_API_KEY || "").trim();
  const services = await Promise.all([
    check("database", "收藏数据库", "媒体记录、设备、片单与设置可正常读取", async () => {
      await getDb().select({ userKey: userState.userKey }).from(userState).limit(1);
      await getDb().select({ id: userSubjects.id }).from(userSubjects).limit(1);
      await getDb().select({ id: userDevices.id }).from(userDevices).limit(1);
    }),
    check("bangumi", "Bangumi 全库", "动画、游戏、出版物与 ACG 音乐可搜索", async () => {
      const response = await fetch("https://api.bgm.tv/v0/subjects/431767", {
        headers: { "user-agent": "TsukiAnimeTracker/1.2" }, signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error("Bangumi unavailable");
    }),
    check("vndb", "VNDB 视觉小说库", "galgame 与视觉小说条目可搜索", async () => {
      const response = await fetch("https://api.vndb.org/kana/vn", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", "user-agent": "TsukiAnimeTracker/1.2" },
        body: JSON.stringify({ filters: ["id", "=", "v11"], fields: "id", results: 1 }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error("VNDB unavailable");
    }),
    check("anilist", "AniList 放送补充", "精确播出时间、集数与封面元数据可正常读取", async () => {
      const response = await fetch("https://graphql.anilist.co", {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "TsukiAnimeTracker/1.2" },
        body: JSON.stringify({ query: "query { Page(page: 1, perPage: 1) { media(type: ANIME, status: RELEASING) { id airingSchedule(notYetAired: true, perPage: 1) { nodes { airingAt episode } } } } }" }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error("AniList unavailable");
      const payload = await response.json() as { errors?: unknown[] };
      if (payload.errors?.length) throw new Error("AniList GraphQL error");
    }),
    check("mangadex", "MangaDex 漫画库", "漫画标题、标签与封面元数据可正常读取", async () => {
      const response = await fetch("https://api.mangadex.org/manga?limit=1&contentRating%5B%5D=safe", {
        headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error("MangaDex unavailable");
    }),
    check("google_books", "Google Books", "普通书籍出版信息与 ISBN 可正常读取", async () => {
      const url = new URL("https://www.googleapis.com/books/v1/volumes");
      url.searchParams.set("q", "isbn:9784046311470");
      url.searchParams.set("maxResults", "1");
      if (googleBooksKey) url.searchParams.set("key", googleBooksKey);
      const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error("Google Books unavailable");
    }),
    check("open_library", "Open Library", "书籍 Work、版本与 ISBN 回退数据可正常读取", async () => {
      const response = await fetch("https://openlibrary.org/search.json?q=isbn%3A9784046311470&limit=1&fields=key", {
        headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error("Open Library unavailable");
    }),
    check("ndl", "NDL 国立国会图书馆", "日本书籍、出版版本与 ISBN 可正常读取", async () => {
      const response = await fetch("https://ndlsearch.ndl.go.jp/api/opensearch?title=%E5%90%9B%E3%81%AE%E5%90%8D%E3%81%AF&cnt=1", {
        headers: { accept: "application/rss+xml, application/xml" }, signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error("NDL unavailable");
    }),
    animeSchedule.token
      ? check("animeschedule", "AnimeSchedule 放送源", "官方周放送时间表可正常读取", async () => {
        const response = await fetch("https://animeschedule.net/api/v3/timetables/raw?tz=Asia%2FTokyo", {
          headers: { accept: "application/json", authorization: `Bearer ${animeSchedule.token}`, "user-agent": "jlHKO/yuexiaji/0.1.0" },
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error("AnimeSchedule unavailable");
      })
      : unconfigured("animeschedule", "AnimeSchedule 放送源", "可在账户安全页面绑定 Application Token"),
  ]);

  return Response.json({ checkedAt: new Date().toISOString(), services }, { headers: { "cache-control": "no-store" } });
}

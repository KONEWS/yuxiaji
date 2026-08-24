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
    check("anilist", "AniList 放送补充", "精确播出时间、集数与封面元数据可正常读取", async () => {
      const response = await fetch("https://graphql.anilist.co", {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "TsukiAnimeTracker/1.2" },
        body: JSON.stringify({ query: "query { Page(page: 1, perPage: 1) { media(type: ANIME, status: RELEASING) { id airingSchedule(notYetAired: true, perPage: 1) { nodes { airingAt episode } } } } }" }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error("AniList unavailable");
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

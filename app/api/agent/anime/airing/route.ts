import { authenticateAgent, isAgentIdentity, requireAgentPermission } from "../../../../lib/agent-auth";
import { getAnimeScheduleCredential } from "../../../../lib/integration-credentials";

const UPSTREAM = "https://animeschedule.net/api/v3/timetables/raw";
const ALLOWED_QUERY = new Set(["source", "tz", "week", "year"]);
const STRING_FIELDS = ["id", "route", "title", "english", "romaji", "native", "episodeDate", "airType", "status"] as const;

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function timetableItems(payload: unknown) {
  const value = payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>).data ?? (payload as Record<string, unknown>).timetable ?? (payload as Record<string, unknown>).items
    : payload;
  if (!Array.isArray(value)) return null;
  // Return schedule data only. Upstream extra properties and credentials never
  // become part of the Agent contract.
  return value.filter((item) => item && typeof item === "object" && !Array.isArray(item)).map((item: Record<string, unknown>) => {
    const row: Record<string, string | number> = {};
    for (const field of STRING_FIELDS) {
      if (typeof item[field] === "string") row[field] = item[field];
    }
    if (typeof item.id === "number" && Number.isFinite(item.id)) row.id = item.id;
    if (typeof item.episodeNumber === "number" && Number.isFinite(item.episodeNumber)) row.episodeNumber = item.episodeNumber;
    return row;
  });
}

export async function GET(request: Request) {
  const identity = authenticateAgent(request);
  if (!isAgentIdentity(identity)) return identity;
  const denied = requireAgentPermission(identity, "airing:read");
  if (denied) return denied;

  const query = new URL(request.url).searchParams;
  for (const name of query.keys()) {
    if (!ALLOWED_QUERY.has(name) || query.getAll(name).length !== 1) return json({ error: "放送查询仅支持 source、tz、week、year，且参数不可重复" }, 400);
  }
  if (query.has("source") && query.get("source") !== "animeschedule") return json({ error: "暂不支持该放送数据源" }, 400);
  const timezone = query.get("tz") || "Asia/Tokyo";
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(); } catch { return json({ error: "tz 必须是有效的 IANA 时区" }, 400); }
  const week = query.get("week");
  const year = query.get("year");
  if ((week === null) !== (year === null)) return json({ error: "week 和 year 必须同时提供" }, 400);
  if (week !== null && (!/^\d{1,2}$/.test(week) || Number(week) < 1 || Number(week) > 53)) return json({ error: "week 必须在 1 到 53 之间" }, 400);
  if (year !== null && (!/^\d{4}$/.test(year) || Number(year) < 2000 || Number(year) > 2200)) return json({ error: "year 必须在 2000 到 2200 之间" }, 400);

  let credential: Awaited<ReturnType<typeof getAnimeScheduleCredential>>;
  try { credential = await getAnimeScheduleCredential(); } catch { return json({ error: "AnimeSchedule 凭据不可用，请在账户集成设置重新绑定" }, 503); }
  if (!credential.token) return json({ error: "AnimeSchedule 未配置，请在账户集成设置绑定 Application Token" }, 503);

  const upstream = new URL(UPSTREAM);
  upstream.searchParams.set("tz", timezone);
  if (week !== null && year !== null) {
    upstream.searchParams.set("week", week);
    upstream.searchParams.set("year", year);
  }
  try {
    const response = await fetch(upstream.toString(), {
      headers: { accept: "application/json", authorization: `Bearer ${credential.token}`, "user-agent": "jlHKO/yuexiaji/0.1.0" },
      signal: AbortSignal.timeout(20000),
      // workerd supports manual/follow, but rejects redirect: "error".
      // Reject every 3xx via response.ok; credentials stay on the fixed host.
      redirect: "manual",
    });
    if (response.status === 401 || response.status === 403) return json({ error: "AnimeSchedule Token 无效或无权读取 timetable" }, 502);
    if (!response.ok) return json({ error: `AnimeSchedule 放送接口返回 HTTP ${response.status}` }, 502);
    const timetable = timetableItems(await response.json());
    if (!timetable) return json({ error: "AnimeSchedule 放送响应缺少 timetable 数组" }, 502);
    return json({ ok: true, source: "animeschedule", credentialSource: credential.source, items: timetable, fetchedAt: new Date().toISOString() });
  } catch {
    // Never forward upstream bodies, credential errors or headers to callers.
    return json({ error: "AnimeSchedule 放送请求失败，请稍后重试" }, 502);
  }
}

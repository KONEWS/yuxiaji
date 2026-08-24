import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { animeAiringSchedule } from "../../../../../db/schema";
import { csrfFailure, requireAdminSession } from "../../../../lib/admin-auth";
import { normalizeJapaneseAirTime, nextAirAtForSchedule, currentAiringSeason } from "../../../../lib/anime-airing";

function text(value: unknown, max: number) { return typeof value === "string" ? value.trim().slice(0, max) : ""; }
function positiveInt(value: unknown) { const number = Number(value); return Number.isInteger(number) && number > 0 ? number : null; }
function weekday(value: unknown) { const number = Number(value); return Number.isInteger(number) && number >= 1 && number <= 7 ? number : null; }
function season(value: unknown, fallback: string) { const normalized = text(value, 20).toLowerCase(); return ["winter", "spring", "summer", "fall"].includes(normalized) ? normalized : fallback; }
function nextAirAt(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export async function POST(request: Request) {
  const csrf = csrfFailure(request);
  if (csrf) return csrf;
  const current = await requireAdminSession(request);
  if (current instanceof Response) return current;
  try {
    const body = await request.json() as Record<string, unknown>;
    const requestedId = positiveInt(body.id);
    const title = text(body.title, 160);
    const subjectId = positiveInt(body.subjectId);
    const day = weekday(body.weekday);
    const rawTime = text(body.airTime ?? body.time, 20);
    const airTime = rawTime ? normalizeJapaneseAirTime(rawTime) : "";
    if (!title || !day) return Response.json({ error: "标题和星期为必填项" }, { status: 400 });
    if (rawTime && !airTime) return Response.json({ error: "播出时间格式无效" }, { status: 400 });
    const defaults = currentAiringSeason();
    const targetSeason = season(body.season, defaults.season);
    const targetYear = Number.isInteger(Number(body.year)) ? Number(body.year) : defaults.year;
    const now = new Date();
    const data = {
      subjectId: subjectId || Math.abs(Date.now()),
      title,
      jpTitle: text(body.jpTitle ?? body.jp, 160),
      weekday: day,
      airTime,
      timezone: "Asia/Tokyo",
      nextEpisode: positiveInt(body.nextEpisode),
      nextAirAt: nextAirAt(body.nextAirAt) || (rawTime ? nextAirAtForSchedule({ weekday: day, airTime: rawTime, now }) : null),
      season: targetSeason,
      year: targetYear,
      source: "custom",
      metadata: JSON.stringify({ description: text(body.description, 500) }),
      lastChecked: now,
      updatedAt: now,
    };
    const db = getDb();
    const [existing] = requestedId
      ? await db.select({ id: animeAiringSchedule.id }).from(animeAiringSchedule).where(and(eq(animeAiringSchedule.id, requestedId), eq(animeAiringSchedule.source, "custom"))).limit(1)
      : await db.select({ id: animeAiringSchedule.id }).from(animeAiringSchedule).where(and(
        eq(animeAiringSchedule.source, "custom"),
        eq(animeAiringSchedule.subjectId, data.subjectId),
        eq(animeAiringSchedule.season, targetSeason),
        eq(animeAiringSchedule.year, targetYear),
      )).limit(1);
    if (requestedId && !existing) return Response.json({ error: "自定义放送不存在" }, { status: 404 });
    if (existing) {
      await db.update(animeAiringSchedule).set(data).where(eq(animeAiringSchedule.id, existing.id));
      return Response.json({ ok: true, id: existing.id, updated: true }, { headers: { "cache-control": "no-store" } });
    }
    const [created] = await db.insert(animeAiringSchedule).values({ ...data, createdAt: now }).returning({ id: animeAiringSchedule.id });
    return Response.json({ ok: true, id: created?.id, created: true }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ error: "保存自定义放送失败", details: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export function PATCH(request: Request) {
  return POST(request);
}

export async function DELETE(request: Request) {
  const csrf = csrfFailure(request);
  if (csrf) return csrf;
  const current = await requireAdminSession(request);
  if (current instanceof Response) return current;
  const id = positiveInt(new URL(request.url).searchParams.get("id"));
  if (!id) return Response.json({ error: "缺少自定义放送 id" }, { status: 400 });
  try {
    const deleted = await getDb().delete(animeAiringSchedule).where(and(eq(animeAiringSchedule.id, id), eq(animeAiringSchedule.source, "custom"))).returning({ id: animeAiringSchedule.id });
    if (!deleted.length) return Response.json({ error: "自定义放送不存在" }, { status: 404 });
    return Response.json({ ok: true, id }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ error: "删除自定义放送失败", details: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { animeAiringSchedule, userSubjects } from "../../../../../db/schema";
import { csrfFailure, requireAdminSession } from "../../../../lib/admin-auth";
import { AIRING_SOURCE, currentAiringSeason, getAiringProvider } from "../../../../lib/anime-airing";
import { getCurrentUser } from "../../../../lib/current-user";

type SyncStage = "preparing" | "requesting" | "parsing" | "matching" | "saving" | "complete";
type ProgressReporter = (progress: number, stage: SyncStage) => void;

type SyncResult = {
  success: true;
  count: number;
  ok: true;
  provider: string;
  season: string;
  year: number;
  requested: number;
  synced: number;
  created: number;
  updated: number;
  failed: number;
  errors: Array<{ subjectId: number; error: string }>;
  matched: number;
  syncedAt: string;
};

function normalizeSeason(value: unknown, fallback: string) {
  const aliases: Record<string, string> = { 冬: "winter", 春: "spring", 夏: "summer", 秋: "fall", winter: "winter", spring: "spring", summer: "summer", fall: "fall", autumn: "fall" };
  return typeof value === "string" ? aliases[value.trim().toLowerCase()] || fallback : fallback;
}

function normalizeYear(value: unknown, fallback: number) {
  const year = Number(value);
  return Number.isInteger(year) && year >= 2000 && year <= 2200 ? year : fallback;
}

async function runSync(input: { season: string; year: number; source: string; userKey: string }, report: ProgressReporter): Promise<SyncResult> {
  report(0, "preparing");
  const provider = getAiringProvider(input.source);
  if (!provider) throw new Error("暂不支持该放送数据源");

  const schedules = await provider.fetchSchedules({
    season: input.season,
    year: input.year,
    onProgress: (progress, stage) => report(progress, stage),
  });

  // Matching is a real database phase. The schedule remains independent from
  // the personal collection; only the number of matching anime is calculated
  // here and the read API performs the same userKey/type join for display.
  report(70, "matching");
  const collected = await getDb().select({ subjectId: userSubjects.subjectId }).from(userSubjects).where(and(
    eq(userSubjects.userKey, input.userKey),
    eq(userSubjects.type, "anime"),
  ));
  const scheduleIds = new Set(schedules.map((item) => item.subjectId));
  const matched = new Set(collected.map((item) => item.subjectId).filter((id): id is number => id !== null && scheduleIds.has(id))).size;

  // No database writes happen until the provider response has been fetched,
  // parsed and matched successfully. Existing schedules are never deleted.
  report(90, "saving");
  const db = getDb();
  const now = new Date();
  let created = 0;
  let updated = 0;
  const errors: Array<{ subjectId: number; error: string }> = [];
  for (const schedule of schedules) {
    try {
      const [existing] = await db.select({ id: animeAiringSchedule.id }).from(animeAiringSchedule).where(and(
        eq(animeAiringSchedule.source, input.source),
        eq(animeAiringSchedule.subjectId, schedule.subjectId),
        eq(animeAiringSchedule.season, input.season),
        eq(animeAiringSchedule.year, input.year),
      )).limit(1);
      const data = {
        subjectId: schedule.subjectId,
        title: schedule.title,
        jpTitle: schedule.jpTitle,
        weekday: schedule.weekday,
        airTime: schedule.airTime,
        timezone: schedule.timezone,
        nextEpisode: schedule.nextEpisode,
        nextAirAt: schedule.nextAirAt,
        season: input.season,
        year: input.year,
        source: input.source,
        metadata: JSON.stringify(schedule.metadata),
        lastChecked: now,
        updatedAt: now,
      };
      if (existing) {
        await db.update(animeAiringSchedule).set(data).where(eq(animeAiringSchedule.id, existing.id));
        updated += 1;
      } else {
        await db.insert(animeAiringSchedule).values({ ...data, createdAt: now });
        created += 1;
      }
    } catch (error) {
      errors.push({ subjectId: schedule.subjectId, error: error instanceof Error ? error.message : "写入失败" });
    }
  }

  const result: SyncResult = {
    success: true,
    count: created + updated,
    ok: true,
    provider: input.source,
    season: input.season,
    year: input.year,
    requested: schedules.length,
    synced: created + updated,
    created,
    updated,
    failed: errors.length,
    errors,
    matched,
    syncedAt: now.toISOString(),
  };
  report(100, "complete");
  return result;
}

function sseResponse(input: { season: string; year: number; source: string; userKey: string }) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown) => controller.enqueue(encoder.encode(
        `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
      ));
      void runSync(input, (progress, stage) => send("progress", { progress, stage }))
        .then((result) => {
          send("complete", result);
          controller.close();
        })
        .catch((error) => {
          send("error", { error: true, message: error instanceof Error ? error.message : String(error) });
          controller.close();
        });
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

export async function POST(request: Request) {
  const csrf = csrfFailure(request);
  if (csrf) return csrf;
  const current = await requireAdminSession(request);
  if (current instanceof Response) return current;

  const body = await request.json().catch(() => ({})) as { season?: unknown; year?: unknown; source?: unknown };
  const defaults = currentAiringSeason();
  const input = {
    season: normalizeSeason(body.season, defaults.season),
    year: normalizeYear(body.year, defaults.year),
    source: typeof body.source === "string" && body.source.trim() ? body.source.trim().slice(0, 40) : AIRING_SOURCE,
    userKey: getCurrentUser(request),
  };
  if (!getAiringProvider(input.source)) return Response.json({ error: true, message: "暂不支持该放送数据源" }, { status: 400 });

  if (request.headers.get("accept")?.includes("text/event-stream")) return sseResponse(input);

  try {
    const result = await runSync(input, () => undefined);
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ error: true, message: error instanceof Error ? error.message : String(error) }, { status: 502, headers: { "cache-control": "no-store" } });
  }
}

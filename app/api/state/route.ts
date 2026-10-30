import { eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { userState } from "../../../db/schema";
import { getCurrentUser } from "../../lib/current-user";
import { guardBrowserApi } from "../../lib/admin-auth";
import { normalizeSyncSettings, normalizeVideoSubtypeLabels, normalizeVisualSubtypeLabels } from "../../lib/constants";

function parseArray(value: string, fallback: unknown[] = []) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function parseObject(value: string) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function GET(request: Request) {
  const guard = await guardBrowserApi(request);
  if (guard) return guard;
  const key = getCurrentUser();
  try {
    const db = getDb();
    const [row] = await db.select().from(userState).where(eq(userState.userKey, key)).limit(1);
    if (!row) return Response.json({ state: null }, { headers: { "cache-control": "no-store" } });
    return Response.json({
      state: {
        collections: parseArray(row.collectionsJson),
        bangumiSyncTypes: parseArray(row.bangumiSyncTypesJson),
        syncSettings: normalizeSyncSettings(parseObject(row.syncSettingsJson)),
        mediaOrder: parseArray(row.mediaOrderJson),
        deviceSubCategories: parseObject(row.deviceSubcategoriesJson),
        deviceCategoryLabels: parseObject(row.deviceCategoryLabelsJson),
        visualSubtypeLabels: normalizeVisualSubtypeLabels(parseObject(row.visualSubtypeLabelsJson)),
        videoSubtypeLabels: normalizeVideoSubtypeLabels(parseObject(row.videoSubtypeLabelsJson)),
        avatarImage: row.avatarImage,
        font: row.font,
        softness: row.softness,
        backgroundVersion: row.backgroundVersion,
        primaryColor: row.primaryColor,
        accentColor: row.accentColor,
        titleMode: row.titleMode,
      },
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "读取失败";
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const guard = await guardBrowserApi(request);
  if (guard) return guard;
  const key = getCurrentUser();
  try {
    let parsed: unknown;
    try {
      parsed = await request.json();
    } catch {
      return Response.json({ error: "请求体必须是有效 JSON 对象" }, { status: 400 });
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return Response.json({ error: "请求体必须是 JSON 对象" }, { status: 400 });
    }
    const payload = parsed as {
      collections?: unknown[];
      bangumiSyncTypes?: unknown[];
      syncSettings?: unknown;
      mediaOrder?: unknown[];
      deviceSubCategories?: Record<string, unknown>;
      deviceCategoryLabels?: Record<string, unknown>;
      visualSubtypeLabels?: Record<string, unknown>;
      videoSubtypeLabels?: Record<string, unknown>;
      avatarImage?: string;
      font?: string;
      softness?: number;
      backgroundVersion?: number;
      primaryColor?: string;
      accentColor?: string;
      titleMode?: string;
    };
    const color = (value: unknown, fallback: string) => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value.toUpperCase() : fallback;
    const next = {
      userKey: key,
      // `anime_json` is a legacy NOT NULL compatibility column. Media is now
      // owned by `user_subjects` and is never read from or written to state.
      animeJson: "[]",
      collectionsJson: JSON.stringify(Array.isArray(payload.collections) ? payload.collections.slice(0, 100) : []),
      bangumiSyncTypesJson: JSON.stringify(Array.isArray(payload.bangumiSyncTypes) ? payload.bangumiSyncTypes.map(String).filter((type) => ["anime", "game", "light_novel", "manga", "music"].includes(type)).slice(0, 5) : []),
      syncSettingsJson: JSON.stringify(normalizeSyncSettings(payload.syncSettings)),
      mediaOrderJson: JSON.stringify(Array.isArray(payload.mediaOrder) ? payload.mediaOrder.slice(0, 12) : []),
      deviceSubcategoriesJson: JSON.stringify(payload.deviceSubCategories && typeof payload.deviceSubCategories === "object" ? payload.deviceSubCategories : {}),
      deviceCategoryLabelsJson: JSON.stringify(payload.deviceCategoryLabels && typeof payload.deviceCategoryLabels === "object" ? payload.deviceCategoryLabels : {}),
      visualSubtypeLabelsJson: JSON.stringify(normalizeVisualSubtypeLabels(payload.visualSubtypeLabels)),
      videoSubtypeLabelsJson: JSON.stringify(normalizeVideoSubtypeLabels(payload.videoSubtypeLabels)),
      avatarImage: typeof payload.avatarImage === "string" && payload.avatarImage.trim().startsWith("/api/avatar") ? payload.avatarImage.trim().slice(0, 600) : "",
      font: ["modern", "round", "serif"].includes(payload.font || "") ? payload.font! : "modern",
      softness: Math.min(94, Math.max(35, Number(payload.softness) || 72)),
      backgroundVersion: Math.max(0, Number(payload.backgroundVersion) || 0),
      primaryColor: color(payload.primaryColor, "#66CCFF"),
      accentColor: color(payload.accentColor, "#8B8CD8"),
      titleMode: payload.titleMode === "jp" ? "jp" : "cn",
      updatedAt: new Date(),
    };
    // Update only supplied preferences, in one upsert. Reading and merging the
    // entire row first would let another tab's unrelated changes be overwritten.
    const fields = {
      collections: "collectionsJson", bangumiSyncTypes: "bangumiSyncTypesJson",
      syncSettings: "syncSettingsJson", mediaOrder: "mediaOrderJson",
      deviceSubCategories: "deviceSubcategoriesJson", deviceCategoryLabels: "deviceCategoryLabelsJson",
      visualSubtypeLabels: "visualSubtypeLabelsJson", videoSubtypeLabels: "videoSubtypeLabelsJson",
      avatarImage: "avatarImage", font: "font", softness: "softness", backgroundVersion: "backgroundVersion",
      primaryColor: "primaryColor", accentColor: "accentColor", titleMode: "titleMode",
    } as const;
    const changes = Object.fromEntries(Object.entries(fields)
      .filter(([field]) => Object.hasOwn(payload, field))
      .map(([, column]) => [column, next[column]]));
    if (!Object.keys(changes).length) return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
    const db = getDb();
    await db.insert(userState).values(next).onConflictDoUpdate({
      target: userState.userKey,
      set: {
        ...changes,
        updatedAt: next.updatedAt,
      },
    });
    return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "保存失败";
    return Response.json({ error: message }, { status: 500 });
  }
}

import { eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { userState } from "../../../db/schema";
import { getCurrentUser } from "../../lib/current-user";
import { normalizeVideoSubtypeLabels, normalizeVisualSubtypeLabels } from "../../lib/constants";

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

export async function GET() {
  const key = getCurrentUser();
  try {
    const db = getDb();
    const [row] = await db.select().from(userState).where(eq(userState.userKey, key)).limit(1);
    if (!row) return Response.json({ state: null }, { headers: { "cache-control": "no-store" } });
    return Response.json({
      state: {
        collections: parseArray(row.collectionsJson),
        bangumiSyncTypes: parseArray(row.bangumiSyncTypesJson),
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
  const key = getCurrentUser();
  try {
    const payload = await request.json() as {
      collections?: unknown[];
      bangumiSyncTypes?: unknown[];
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
    const db = getDb();
    await db.insert(userState).values(next).onConflictDoUpdate({
      target: userState.userKey,
      set: {
        collectionsJson: next.collectionsJson,
        bangumiSyncTypesJson: next.bangumiSyncTypesJson,
        mediaOrderJson: next.mediaOrderJson,
        deviceSubcategoriesJson: next.deviceSubcategoriesJson,
        deviceCategoryLabelsJson: next.deviceCategoryLabelsJson,
        visualSubtypeLabelsJson: next.visualSubtypeLabelsJson,
        videoSubtypeLabelsJson: next.videoSubtypeLabelsJson,
        avatarImage: next.avatarImage,
        font: next.font,
        softness: next.softness,
        backgroundVersion: next.backgroundVersion,
        primaryColor: next.primaryColor,
        accentColor: next.accentColor,
        titleMode: next.titleMode,
        updatedAt: next.updatedAt,
      },
    });
    return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "保存失败";
    return Response.json({ error: message }, { status: 500 });
  }
}

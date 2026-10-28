import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { userDevices } from "../../../db/schema";
import { getCurrentUser } from "../../lib/current-user";
import { finishAgentOperation, reserveAgentOperation } from "../../lib/agent-operations";

const DEVICE_STATUSES = ["active", "backup", "retired"];
const CURRENCIES = ["CNY"];
const CATEGORY_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/i;

function normalizeCategory(value: unknown) {
  const category = typeof value === "string" ? value.trim().slice(0, 40) : "";
  return CATEGORY_PATTERN.test(category) ? category : "audio";
}

export function parseTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === "string" || typeof item === "number") ? String(item).trim() : "").filter(Boolean).slice(0, 12);
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parseTags(parsed);
    } catch {
      // 逗号分隔的字符串
    }
    return value.split(/[,，、\s]+/).map((item) => item.trim()).filter(Boolean).slice(0, 12);
  }
  return [];
}

function serializeTags(tags: unknown): string {
  return JSON.stringify(parseTags(tags));
}

function parseCoverPosition(value: unknown) {
  if (value === undefined || value === null || value === "") return 50;
  const position = Number(value);
  return Number.isFinite(position) ? Math.round(Math.min(100, Math.max(0, position))) : 50;
}

function parseCoverZoom(value: unknown) {
  if (value === undefined || value === null || value === "") return 100;
  const zoom = Number(value);
  return Number.isFinite(zoom) ? Math.round(Math.min(240, Math.max(100, zoom))) : 100;
}

export function sanitizeDevice(body: Record<string, unknown>) {
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
  const category = normalizeCategory(body.category);
  const subCategory = typeof body.subCategory === "string" ? body.subCategory.trim().slice(0, 30) : "";
  const status = DEVICE_STATUSES.includes(body.status as string) ? body.status as string : "active";
  const currency = CURRENCIES.includes(body.currency as string) ? body.currency as string : "CNY";
  const price = body.price === null || body.price === undefined || typeof body.price === "string" && !body.price.trim()
    ? NaN : Number(body.price);
  const purchaseDate = typeof body.purchaseDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.purchaseDate) ? body.purchaseDate : null;
  const receiptImage = typeof body.receiptImage === "string" ? body.receiptImage.trim().slice(0, 500) : "";
  const coverImage = typeof body.coverImage === "string" ? body.coverImage.trim().slice(0, 500) : "";
  const coverPositionX = parseCoverPosition(body.coverPositionX);
  const coverPositionY = parseCoverPosition(body.coverPositionY);
  const coverZoom = parseCoverZoom(body.coverZoom);
  const rating = Number(body.rating);
  const review = typeof body.review === "string" ? body.review.trim().slice(0, 2000) : "";
  return {
    name: name || "未命名设备",
    category,
    subCategory,
    status,
    price: Number.isFinite(price) && price >= 0 ? Math.round(price * 100) / 100 : null,
    currency,
    purchaseDate,
    receiptImage,
    coverImage,
    coverPositionX,
    coverPositionY,
    coverZoom,
    tags: serializeTags(body.tags),
    rating: Number.isInteger(rating) && rating >= 1 && rating <= 10 ? rating : null,
    review,
    updatedAt: new Date(),
  };
}

export function presentDevice(row: typeof userDevices.$inferSelect) {
  return { ...row, tags: parseTags(row.tags) };
}

/** 设备列表 + 在役总数 + 总投入金额统计 */
export async function GET(request: Request) {
  const key = getCurrentUser();
  const url = new URL(request.url);
  const category = url.searchParams.get("category");
  const subCategory = url.searchParams.get("subCategory");
  const status = url.searchParams.get("status");
  try {
    const conditions = [eq(userDevices.userKey, key)];
    if (category && CATEGORY_PATTERN.test(category)) conditions.push(eq(userDevices.category, category));
    if (subCategory) conditions.push(eq(userDevices.subCategory, subCategory));
    if (status && DEVICE_STATUSES.includes(status)) conditions.push(eq(userDevices.status, status));
    const db = getDb();
    const rows = await db.select().from(userDevices).where(and(...conditions)).orderBy(desc(userDevices.updatedAt));
    const allRows = await db.select({ status: userDevices.status, price: userDevices.price }).from(userDevices).where(eq(userDevices.userKey, key));
    const devices = rows.map(presentDevice);
    const active = allRows.filter((device) => device.status === "active").length;
    const totalInvestment = allRows.reduce((sum, device) => sum + (device.price || 0), 0);
    return Response.json({
      devices,
      stats: {
        count: devices.length,
        active,
        totalInvestment: Math.round(totalInvestment * 100) / 100,
      },
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "读取失败";
    return Response.json({ error: message }, { status: 500 });
  }
}

/** 新增 / 更新设备：携带 id 时更新，否则新增 */
export async function POST(request: Request) {
  const key = getCurrentUser();
  let createOperationId: number | null = null;
  try {
    let body: Record<string, unknown>;
    try {
      const parsed = await request.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return Response.json({ error: "请求体必须是 JSON 对象" }, { status: 400 });
      body = parsed as Record<string, unknown>;
    } catch {
      return Response.json({ error: "请求体必须是有效 JSON" }, { status: 400 });
    }
    const next = sanitizeDevice(body);
    const db = getDb();
    const requestedId = Number(body.id);
    let device: typeof userDevices.$inferSelect;
    if (Number.isInteger(requestedId) && requestedId > 0) {
      const [existing] = await db.select().from(userDevices).where(and(eq(userDevices.id, requestedId), eq(userDevices.userKey, key))).limit(1);
      if (!existing) return Response.json({ error: "设备不存在或无权修改" }, { status: 404 });
      const update = {
        ...next,
        coverPositionX: body.coverPositionX === undefined ? existing.coverPositionX : next.coverPositionX,
        coverPositionY: body.coverPositionY === undefined ? existing.coverPositionY : next.coverPositionY,
        coverZoom: body.coverZoom === undefined ? existing.coverZoom : next.coverZoom,
      };
      await db.update(userDevices).set(update).where(and(eq(userDevices.id, requestedId), eq(userDevices.userKey, key)));
      device = { ...existing, ...update, id: requestedId };
    } else {
      if (Object.prototype.hasOwnProperty.call(body, "idempotencyKey") || request.headers.has("idempotency-key") || request.headers.has("x-idempotency-key")) {
        const reservation = await reserveAgentOperation({ agent: "browser", source: "browser", userKey: key }, {
          request, body, resource: "devices", action: "create",
        });
        if (reservation.kind !== "reserved") {
          if (reservation.kind === "replayed" && reservation.response.ok) {
            const receipt = await reservation.response.clone().json() as { device?: { id?: number } };
            const createdId = receipt.device?.id;
            const [stillPresent] = createdId ? await db.select({ id: userDevices.id }).from(userDevices)
              .where(and(eq(userDevices.id, createdId), eq(userDevices.userKey, key))).limit(1) : [];
            if (!stillPresent) return Response.json({ error: "原请求创建的藏品已被删除，重试不会重新创建。", code: "operation_resource_missing", retryable: false }, {
              status: 409, headers: { "cache-control": "no-store", "x-idempotent-replay": "true" },
            });
          }
          return reservation.response;
        }
        createOperationId = reservation.id;
      }
      const [created] = await db.insert(userDevices).values({ ...next, userKey: key }).returning();
      if (!created) throw new Error("写入失败");
      device = created;
    }
    const payload = { ok: true, device: presentDevice(device) };
    if (createOperationId !== null) await finishAgentOperation(createOperationId, 200, payload);
    return Response.json(payload, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (createOperationId !== null) {
      // A failed response does not prove that D1 rolled the insert back. Keep
      // the original reservation so a retry cannot create another device.
      return Response.json({ error: "藏品创建结果暂时无法确认，请保留原请求重试并核对藏品，不要重复新建。", code: "operation_outcome_unknown", retryable: false }, { status: 503, headers: { "cache-control": "no-store" } });
    }
    const message = error instanceof Error ? error.message : "保存失败";
    return Response.json({ error: message }, { status: 500 });
  }
}

/** 删除设备（仅限本人名下） */
export async function DELETE(request: Request) {
  const key = getCurrentUser();
  try {
    const url = new URL(request.url);
    const id = Number(url.searchParams.get("id"));
    if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "缺少设备 id" }, { status: 400 });
    const result = await getDb().delete(userDevices).where(and(eq(userDevices.id, id), eq(userDevices.userKey, key))).returning({ id: userDevices.id });
    if (!result.length) return Response.json({ error: "设备不存在或无权删除" }, { status: 404 });
    return Response.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "删除失败";
    return Response.json({ error: message }, { status: 500 });
  }
}

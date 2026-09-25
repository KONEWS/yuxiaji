import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { userDevices } from "../../../../db/schema";
import { authenticateAgent, isAgentIdentity, requireAgentPermission, type AgentIdentity } from "../../../lib/agent-auth";
import { agentJson, finishAgentOperation, reserveAgentOperation } from "../../../lib/agent-operations";
import { presentDevice, sanitizeDevice } from "../../devices/route";

const DEVICE_STATUSES = ["active", "backup", "retired"];
const CATEGORY_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/i;

function deviceWithAgent(row: typeof userDevices.$inferSelect, agent: AgentIdentity["agent"]) {
  return { ...presentDevice(row), source: "openclaw", agent, managedBy: "openclaw" };
}

async function writeDevice(request: Request, identity: AgentIdentity, action: "create" | "update", body: Record<string, unknown>) {
  const requestedId = Number(body.id);
  const id = Number.isInteger(requestedId) && requestedId > 0 ? requestedId : null;
  const denied = requireAgentPermission(identity, action === "create" ? "devices:create" : "devices:update");
  if (denied) return denied;
  const reservation = await reserveAgentOperation(identity, { request, body, resource: "device", action, resourceId: id });
  if (reservation.kind !== "reserved") return reservation.response;
  try {
    const db = getDb();
    const next = sanitizeDevice(body);
    let row: typeof userDevices.$inferSelect;
    let status = 201;
    if (id) {
      const [existing] = await db.select().from(userDevices).where(and(eq(userDevices.id, id), eq(userDevices.userKey, identity.userKey))).limit(1);
      if (!existing) {
        const payload = { error: "设备不存在或无权修改" };
        await finishAgentOperation(reservation.id, 404, payload);
        return agentJson(payload, 404);
      }
      const update = {
        ...next,
        coverPositionX: body.coverPositionX === undefined ? existing.coverPositionX : next.coverPositionX,
        coverPositionY: body.coverPositionY === undefined ? existing.coverPositionY : next.coverPositionY,
        coverZoom: body.coverZoom === undefined ? existing.coverZoom : next.coverZoom,
      };
      await db.update(userDevices).set(update).where(and(eq(userDevices.id, id), eq(userDevices.userKey, identity.userKey)));
      row = { ...existing, ...update, id };
      status = 200;
    } else {
      const [created] = await db.insert(userDevices).values({ ...next, userKey: identity.userKey }).returning();
      if (!created) throw new Error("写入设备记录失败");
      row = created;
    }
    const payload = { ok: true, source: "openclaw", agent: identity.agent, idempotencyKey: reservation.idempotencyKey, device: deviceWithAgent(row, identity.agent) };
    await finishAgentOperation(reservation.id, status, payload);
    return agentJson(payload, status);
  } catch (error) {
    const payload = { error: error instanceof Error ? error.message : "保存设备记录失败" };
    await finishAgentOperation(reservation.id, 500, payload);
    return agentJson(payload, 500);
  }
}

export async function GET(request: Request) {
  const identity = authenticateAgent(request);
  if (!isAgentIdentity(identity)) return identity;
  const denied = requireAgentPermission(identity, "devices:read");
  if (denied) return denied;
  const url = new URL(request.url);
  const id = Number(url.searchParams.get("id"));
  const category = url.searchParams.get("category");
  const subCategory = url.searchParams.get("subCategory");
  const status = url.searchParams.get("status");
  try {
    const conditions = [eq(userDevices.userKey, identity.userKey)];
    if (Number.isInteger(id) && id > 0) conditions.push(eq(userDevices.id, id));
    if (category && CATEGORY_PATTERN.test(category)) conditions.push(eq(userDevices.category, category));
    if (subCategory) conditions.push(eq(userDevices.subCategory, subCategory));
    if (status && DEVICE_STATUSES.includes(status)) conditions.push(eq(userDevices.status, status));
    const db = getDb();
    const rows = await db.select().from(userDevices).where(and(...conditions)).orderBy(desc(userDevices.updatedAt));
    const allRows = await db.select({ status: userDevices.status, price: userDevices.price }).from(userDevices).where(eq(userDevices.userKey, identity.userKey));
    const devices = rows.map((row) => deviceWithAgent(row, identity.agent));
    return agentJson({ devices, device: Number.isInteger(id) && id > 0 ? devices[0] || null : undefined, stats: { count: devices.length, active: allRows.filter((item) => item.status === "active").length, totalInvestment: Math.round(allRows.reduce((sum, item) => sum + (item.price || 0), 0) * 100) / 100 }, source: "openclaw", agent: identity.agent });
  } catch (error) {
    return agentJson({ error: error instanceof Error ? error.message : "读取设备记录失败" }, 500);
  }
}

export async function POST(request: Request) {
  const identity = authenticateAgent(request);
  if (!isAgentIdentity(identity)) return identity;
  let body: Record<string, unknown>;
  try { body = await request.clone().json() as Record<string, unknown>; } catch { return agentJson({ error: "请求体必须是 JSON" }, 400); }
  return writeDevice(request, identity, Number(body.id) > 0 ? "update" : "create", body);
}

export async function PATCH(request: Request) {
  const identity = authenticateAgent(request);
  if (!isAgentIdentity(identity)) return identity;
  let body: Record<string, unknown>;
  try { body = await request.clone().json() as Record<string, unknown>; } catch { return agentJson({ error: "请求体必须是 JSON" }, 400); }
  const id = Number(new URL(request.url).searchParams.get("id"));
  if (!Number.isInteger(Number(body.id)) && Number.isInteger(id) && id > 0) body.id = id;
  return writeDevice(request, identity, "update", body);
}

export async function DELETE(request: Request) {
  const identity = authenticateAgent(request);
  if (!isAgentIdentity(identity)) return identity;
  const denied = requireAgentPermission(identity, "devices:delete");
  if (denied) return denied;
  const id = Number(new URL(request.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return agentJson({ error: "缺少设备 id" }, 400);
  const reservation = await reserveAgentOperation(identity, { request, resource: "device", action: "delete", resourceId: id });
  if (reservation.kind !== "reserved") return reservation.response;
  try {
    const result = await getDb().delete(userDevices).where(and(eq(userDevices.id, id), eq(userDevices.userKey, identity.userKey))).returning({ id: userDevices.id });
    if (!result.length) {
      const payload = { error: "设备不存在或无权删除" };
      await finishAgentOperation(reservation.id, 404, payload);
      return agentJson(payload, 404);
    }
    const payload = { ok: true, source: "openclaw", agent: identity.agent, idempotencyKey: reservation.idempotencyKey, deleted: { id } };
    await finishAgentOperation(reservation.id, 200, payload);
    return agentJson(payload);
  } catch (error) {
    const payload = { error: error instanceof Error ? error.message : "删除设备记录失败" };
    await finishAgentOperation(reservation.id, 500, payload);
    return agentJson(payload, 500);
  }
}

import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { userSubjects } from "../../../../db/schema";
import { authenticateAgent, isAgentIdentity, requireAgentPermission } from "../../../lib/agent-auth";
import { agentJson, finishAgentOperation, reserveAgentOperation } from "../../../lib/agent-operations";
import { parseTags } from "../../media/route";

function cleanTags(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => String(item).trim()).filter(Boolean))).slice(0, 30);
}

export async function GET(request: Request) {
  const identity = authenticateAgent(request);
  if (!isAgentIdentity(identity)) return identity;
  const denied = requireAgentPermission(identity, "tags:read");
  if (denied) return denied;
  try {
    const rows = await getDb().select({ tags: userSubjects.tags }).from(userSubjects).where(eq(userSubjects.userKey, identity.userKey)).orderBy(desc(userSubjects.updatedAt));
    const counts = new Map<string, number>();
    rows.flatMap((row) => parseTags(row.tags)).forEach((tag) => counts.set(tag, (counts.get(tag) || 0) + 1));
    const tags = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN")).map(([tag, count]) => ({ tag, count }));
    return agentJson({ tags, source: "openclaw", agent: identity.agent });
  } catch (error) {
    return agentJson({ error: error instanceof Error ? error.message : "读取标签失败" }, 500);
  }
}

export async function POST(request: Request) {
  const identity = authenticateAgent(request);
  if (!isAgentIdentity(identity)) return identity;
  const denied = requireAgentPermission(identity, "tags:manage");
  if (denied) return denied;
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; } catch { return agentJson({ error: "请求体必须是 JSON" }, 400); }
  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) return agentJson({ error: "缺少媒体记录 id" }, 400);
  const tags = cleanTags(body.tags);
  const reservation = await reserveAgentOperation(identity, { request, body, resource: "tags", action: "replace", resourceId: id });
  if (reservation.kind !== "reserved") return reservation.response;
  try {
    const db = getDb();
    const [existing] = await db.select().from(userSubjects).where(and(eq(userSubjects.id, id), eq(userSubjects.userKey, identity.userKey))).limit(1);
    if (!existing) {
      const payload = { error: "媒体记录不存在或无权修改标签" };
      await finishAgentOperation(reservation.id, 404, payload);
      return agentJson(payload, 404);
    }
    await db.update(userSubjects).set({ tags: JSON.stringify(tags), updatedAt: new Date() }).where(and(eq(userSubjects.id, id), eq(userSubjects.userKey, identity.userKey)));
    const payload = { ok: true, source: "openclaw", agent: identity.agent, idempotencyKey: reservation.idempotencyKey, mediaId: id, tags };
    await finishAgentOperation(reservation.id, 200, payload);
    return agentJson(payload);
  } catch (error) {
    const payload = { error: error instanceof Error ? error.message : "保存标签失败" };
    await finishAgentOperation(reservation.id, 500, payload);
    return agentJson(payload, 500);
  }
}

export async function DELETE(request: Request) {
  const identity = authenticateAgent(request);
  if (!isAgentIdentity(identity)) return identity;
  const denied = requireAgentPermission(identity, "tags:manage");
  if (denied) return denied;
  const tag = new URL(request.url).searchParams.get("tag")?.trim();
  if (!tag) return agentJson({ error: "缺少 tag" }, 400);
  const reservation = await reserveAgentOperation(identity, { request, resource: "tags", action: "remove", requireKey: true });
  if (reservation.kind !== "reserved") return reservation.response;
  try {
    const db = getDb();
    const rows = await db.select().from(userSubjects).where(eq(userSubjects.userKey, identity.userKey));
    let changed = 0;
    for (const row of rows) {
      const tags = parseTags(row.tags);
      const next = tags.filter((item) => item !== tag);
      if (next.length !== tags.length) {
        await db.update(userSubjects).set({ tags: JSON.stringify(next), updatedAt: new Date() }).where(and(eq(userSubjects.id, row.id), eq(userSubjects.userKey, identity.userKey)));
        changed += 1;
      }
    }
    const payload = { ok: true, source: "openclaw", agent: identity.agent, idempotencyKey: reservation.idempotencyKey, tag, changed };
    await finishAgentOperation(reservation.id, 200, payload);
    return agentJson(payload);
  } catch (error) {
    const payload = { error: error instanceof Error ? error.message : "删除标签失败" };
    await finishAgentOperation(reservation.id, 500, payload);
    return agentJson(payload, 500);
  }
}


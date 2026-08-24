import { and, eq } from "drizzle-orm";
import { getDb } from "../../db";
import { agentOperations } from "../../db/schema";
import type { AgentIdentity } from "./agent-auth";

type OperationInput = {
  request: Request;
  body?: Record<string, unknown>;
  resource: string;
  action: string;
  resourceId?: number | null;
  requireKey?: boolean;
};

type ReservedOperation = { kind: "reserved"; id: number; idempotencyKey: string };
type ReplayedOperation = { kind: "replayed"; response: Response };
type PendingOperation = { kind: "pending"; response: Response };
type InvalidOperation = { kind: "invalid"; response: Response };
export type AgentOperationReservation = ReservedOperation | ReplayedOperation | PendingOperation | InvalidOperation;

function responseHeaders(replayed = false) {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  if (replayed) headers.set("x-idempotent-replay", "true");
  return headers;
}

function normalizeKey(request: Request, body?: Record<string, unknown>) {
  const candidate = request.headers.get("idempotency-key") || request.headers.get("x-idempotency-key") || body?.idempotencyKey;
  if (typeof candidate !== "string") return "";
  return candidate.trim().slice(0, 160);
}

export function readAgentIdempotencyKey(input: OperationInput) {
  const key = normalizeKey(input.request, input.body);
  if (key || input.requireKey === false) return key || `auto-${crypto.randomUUID()}`;
  return "";
}

export async function reserveAgentOperation(identity: AgentIdentity, input: OperationInput): Promise<AgentOperationReservation> {
  const idempotencyKey = readAgentIdempotencyKey(input);
  if (!idempotencyKey) return { kind: "invalid", response: Response.json({ error: "写操作需要 idempotencyKey" }, { status: 400, headers: responseHeaders() }) };
  const db = getDb();
  const [reserved] = await db.insert(agentOperations).values({
    userKey: identity.userKey,
    source: identity.source,
    agent: identity.agent,
    idempotencyKey,
    resource: input.resource,
    action: input.action,
    resourceId: input.resourceId ?? null,
    statusCode: 102,
    responseJson: JSON.stringify({ pending: true }),
    createdAt: new Date(),
  }).onConflictDoNothing({ target: [agentOperations.userKey, agentOperations.agent, agentOperations.idempotencyKey] }).returning({ id: agentOperations.id });
  if (reserved?.id) return { kind: "reserved", id: reserved.id, idempotencyKey };

  const [existing] = await db.select().from(agentOperations).where(and(
    eq(agentOperations.userKey, identity.userKey),
    eq(agentOperations.agent, identity.agent),
    eq(agentOperations.idempotencyKey, idempotencyKey),
  )).limit(1);
  if (!existing) return { kind: "pending", response: Response.json({ error: "幂等操作状态暂不可用，请稍后重试" }, { status: 409, headers: responseHeaders() }) };
  if (existing.statusCode === 102) return { kind: "pending", response: Response.json({ error: "相同 idempotencyKey 正在处理中" }, { status: 409, headers: responseHeaders() }) };
  return { kind: "replayed", response: new Response(existing.responseJson, { status: existing.statusCode, headers: responseHeaders(true) }) };
}

export async function finishAgentOperation(id: number, statusCode: number, payload: unknown) {
  await getDb().update(agentOperations).set({ statusCode, responseJson: JSON.stringify(payload).slice(0, 200000) }).where(eq(agentOperations.id, id));
}

export function agentJson(payload: unknown, status = 200, extraHeaders?: HeadersInit) {
  return Response.json(payload, { status, headers: { ...Object.fromEntries(responseHeaders()), ...extraHeaders } });
}


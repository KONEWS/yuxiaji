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
type OperationResponse = { kind: "replayed" | "pending" | "invalid"; response: Response };
export type AgentOperationReservation = ReservedOperation | OperationResponse;
const STALE_AFTER_MS = 10 * 60 * 1000;
const RETRY_AFTER_SECONDS = 5;

function responseHeaders(replayed = false) {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  if (replayed) headers.set("x-idempotent-replay", "true");
  return headers;
}

function normalizeKey(request: Request, body?: Record<string, unknown>) {
  const candidate = request.headers.get("idempotency-key") || request.headers.get("x-idempotency-key") || body?.idempotencyKey;
  // Never truncate: distinct long keys must not silently become the same operation.
  return typeof candidate === "string" ? candidate.trim() : "";
}

export function readAgentIdempotencyKey(input: OperationInput) {
  const key = normalizeKey(input.request, input.body);
  if (key || input.requireKey === false) return key || `auto-${crypto.randomUUID()}`;
  return "";
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => [key, canonical(item)]));
  return value;
}

async function requestHash(input: OperationInput) {
  const url = new URL(input.request.url);
  url.searchParams.delete("idempotencyKey");
  url.searchParams.sort();
  const body = { ...input.body };
  delete body.idempotencyKey;
  const bytes = new TextEncoder().encode(JSON.stringify(canonical({
    method: input.request.method, path: url.pathname, query: url.searchParams.toString(),
    resource: input.resource, action: input.action, resourceId: input.resourceId ?? null, body,
  })));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function conditions(identity: AgentIdentity, key: string) {
  return and(eq(agentOperations.userKey, identity.userKey), eq(agentOperations.agent, identity.agent), eq(agentOperations.idempotencyKey, key));
}

type Operation = typeof agentOperations.$inferSelect;
function pendingResponse(operation?: Operation): OperationResponse {
  const stale = operation && Date.now() - (operation.startedAt ?? operation.createdAt).getTime() >= STALE_AFTER_MS;
  return { kind: "pending", response: Response.json({
    error: stale ? "操作已超时，执行结果待核对；请先读取目标条目，不要换键重复创建" : "相同操作正在处理中，请稍后使用原幂等键重试",
    code: stale ? "operation_outcome_unknown" : "operation_pending",
    operationId: operation?.id, state: stale ? "uncertain" : "pending", retryable: false,
    ...(stale ? {} : { retryAfterSeconds: RETRY_AFTER_SECONDS }),
  }, { status: 409, headers: { ...Object.fromEntries(responseHeaders()), ...(stale ? {} : { "retry-after": String(RETRY_AFTER_SECONDS) }) } }) };
}

export async function reserveAgentOperation(identity: AgentIdentity, input: OperationInput): Promise<AgentOperationReservation> {
  const idempotencyKey = readAgentIdempotencyKey(input);
  if (!idempotencyKey || idempotencyKey.length > 160) return { kind: "invalid", response: agentJson({ error: "写操作需要 1–160 字符的 idempotencyKey" }, 400) };
  const hash = await requestHash(input);
  const db = getDb();
  const [reserved] = await db.insert(agentOperations).values({
    userKey: identity.userKey, source: identity.source, agent: identity.agent, idempotencyKey,
    resource: input.resource, action: input.action, resourceId: input.resourceId ?? null,
    requestHash: hash, retrySafe: false, startedAt: new Date(), statusCode: 102,
    responseJson: JSON.stringify({ pending: true }), createdAt: new Date(),
  }).onConflictDoNothing({ target: [agentOperations.userKey, agentOperations.agent, agentOperations.idempotencyKey] }).returning({ id: agentOperations.id });
  if (reserved?.id) return { kind: "reserved", id: reserved.id, idempotencyKey };

  const [existing] = await db.select().from(agentOperations).where(conditions(identity, idempotencyKey)).limit(1);
  if (!existing) return pendingResponse();
  if (existing.resource !== input.resource || existing.action !== input.action || existing.resourceId !== (input.resourceId ?? null)
    || (existing.requestHash && existing.requestHash !== hash)) {
    return { kind: "invalid", response: agentJson({ error: "幂等键已用于不同操作或内容，请为新操作使用新键", code: "idempotency_conflict" }, 409) };
  }
  if (existing.statusCode === 102) return pendingResponse(existing);
  // Only explicit pre-write failures can be retried. Time passing is never proof
  // that a D1/R2 mutation did not commit. Legacy operations remain replay-only.
  if (existing.retrySafe && existing.requestHash === hash) {
    const elapsed = Date.now() - (existing.startedAt ?? existing.createdAt).getTime();
    if (elapsed < RETRY_AFTER_SECONDS * 1000) return { kind: "pending", response: agentJson({
      error: "服务暂不可用，请稍后使用原幂等键重试", code: "operation_retry_later", retryable: true, retryAfterSeconds: RETRY_AFTER_SECONDS,
    }, 503, { "retry-after": String(RETRY_AFTER_SECONDS) }) };
    const [claimed] = await db.update(agentOperations).set({ statusCode: 102, retrySafe: false, startedAt: new Date(), responseJson: JSON.stringify({ pending: true }) })
      .where(and(conditions(identity, idempotencyKey), eq(agentOperations.statusCode, existing.statusCode), eq(agentOperations.retrySafe, true), eq(agentOperations.requestHash, hash)))
      .returning({ id: agentOperations.id });
    if (claimed) return { kind: "reserved", id: claimed.id, idempotencyKey };
    return pendingResponse();
  }
  return { kind: "replayed", response: new Response(existing.responseJson, { status: existing.statusCode, headers: responseHeaders(true) }) };
}

/** Call retrySafe only when no persistent mutation has been attempted. */
export async function finishAgentOperation(id: number, statusCode: number, payload: unknown, options: { retrySafe?: boolean } = {}) {
  const retrySafe = options.retrySafe === true && statusCode >= 500;
  const response = retrySafe && payload && typeof payload === "object" ? { ...payload, retryable: true, retryAfterSeconds: RETRY_AFTER_SECONDS } : payload;
  let responseJson = JSON.stringify(response);
  if (responseJson.length > 200000) {
    // Truncation creates invalid JSON and may make a committed write look retryable.
    responseJson = JSON.stringify({ error: "操作回执过大，请读取目标资源核对结果", code: "operation_receipt_too_large", retryable: false });
    statusCode = 409;
  }
  await getDb().update(agentOperations).set({ statusCode, responseJson, retrySafe: retrySafe && statusCode >= 500,
      // Start the backoff when failure is recorded, even after a slow request.
      ...(retrySafe ? { startedAt: new Date() } : {}),
    })
    .where(and(eq(agentOperations.id, id), eq(agentOperations.statusCode, 102)));
}

/** Read-only, scoped to this user AND agent; never exposes stored request bodies. */
export async function readAgentOperation(identity: AgentIdentity, key: string) {
  const [operation] = await getDb().select().from(agentOperations).where(conditions(identity, key)).limit(1);
  if (!operation) return null;
  const pending = operation.statusCode === 102;
  const stale = pending && Date.now() - (operation.startedAt ?? operation.createdAt).getTime() >= STALE_AFTER_MS;
  return { id: operation.id, resource: operation.resource, action: operation.action, resourceId: operation.resourceId,
    state: pending ? (stale ? "uncertain" : "pending") : operation.retrySafe ? "retryable" : operation.statusCode < 400 ? "succeeded" : operation.statusCode >= 500 ? "uncertain" : "failed",
    statusCode: operation.statusCode, retryable: operation.retrySafe, createdAt: operation.createdAt,
    ...(pending && !stale || operation.retrySafe ? { retryAfterSeconds: RETRY_AFTER_SECONDS } : {}),
    nextAction: pending ? (stale ? "read_resource_before_retry" : "wait") : operation.retrySafe ? "retry_same_request_and_key" : operation.statusCode < 400 ? "replay_same_request" : "read_resource_before_retry",
  };
}

export function agentJson(payload: unknown, status = 200, extraHeaders?: HeadersInit) {
  return Response.json(payload, { status, headers: { ...Object.fromEntries(responseHeaders()), ...extraHeaders } });
}

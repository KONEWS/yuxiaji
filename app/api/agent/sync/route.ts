import { POST as bangumiSync } from "../../bangumi/sync/route";
import { authenticateAgent, isAgentIdentity, requireAgentPermission } from "../../../lib/agent-auth";
import { agentJson, finishAgentOperation, reserveAgentOperation } from "../../../lib/agent-operations";

export async function POST(request: Request) {
  const identity = authenticateAgent(request);
  if (!isAgentIdentity(identity)) return identity;
  const denied = requireAgentPermission(identity, "bangumi:sync");
  if (denied) return denied;
  const requestCopy = request.clone();
  let body: Record<string, unknown> = {};
  try { body = await request.clone().json() as Record<string, unknown>; } catch { return agentJson({ error: "请求体必须是 JSON" }, 400); }
  const reservation = await reserveAgentOperation(identity, { request, body, resource: "bangumi", action: "sync" });
  if (reservation.kind !== "reserved") return reservation.response;
  try {
    const response = await bangumiSync(requestCopy);
    const payload = await response.clone().json().catch(() => ({ error: "Bangumi 同步返回了无法解析的响应" }));
    const enriched = { ...payload, source: "openclaw", agent: identity.agent, idempotencyKey: reservation.idempotencyKey };
    await finishAgentOperation(reservation.id, response.status, enriched);
    return agentJson(enriched, response.status);
  } catch (error) {
    const payload = { error: error instanceof Error ? error.message : "Bangumi 同步失败" };
    await finishAgentOperation(reservation.id, 502, payload);
    return agentJson(payload, 502);
  }
}


import { authenticateAgent, isAgentIdentity } from "../../../lib/agent-auth";
import { agentJson, readAgentOperation } from "../../../lib/agent-operations";

export async function GET(request: Request) {
  const identity = authenticateAgent(request);
  if (!isAgentIdentity(identity)) return identity;
  const key = new URL(request.url).searchParams.get("idempotencyKey")?.trim();
  if (!key || key.length > 160) return agentJson({ error: "需要 1–160 字符的 idempotencyKey" }, 400);
  const operation = await readAgentOperation(identity, key);
  return operation ? agentJson({ operation }) : agentJson({ error: "操作不存在" }, 404);
}

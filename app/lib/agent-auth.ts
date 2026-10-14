import { env } from "cloudflare:workers";
import { getCurrentUser } from "./current-user";

export type AgentName = "nova" | "hikari" | "codex" | "chatgpt";
export type AgentPermission =
  | "media:read"
  | "media:create"
  | "media:update"
  | "media:delete"
  | "devices:read"
  | "devices:create"
  | "devices:update"
  | "devices:delete"
  | "tags:read"
  | "tags:manage"
  | "gallery:read"
  | "gallery:create"
  | "gallery:update"
  | "gallery:delete"
  | "video:read"
  | "video:create"
  | "video:update"
  | "video:delete"
  | "storage:read"
  | "storage:create"
  | "storage:update"
  | "storage:delete"
  | "bangumi:sync"
  | "airing:read";

export type AgentIdentity = { agent: AgentName; userKey: string; source: "openclaw" };

const FULL_PERMISSIONS: readonly AgentPermission[] = [
  "media:read", "media:create", "media:update", "media:delete",
  "devices:read", "devices:create", "devices:update", "devices:delete",
  "tags:read", "tags:manage", "bangumi:sync", "airing:read",
  "gallery:read", "gallery:create", "gallery:update", "gallery:delete",
  "video:read", "video:create", "video:update", "video:delete",
  "storage:read", "storage:create", "storage:update", "storage:delete",
];

const PERMISSIONS: Record<AgentName, readonly AgentPermission[]> = {
  nova: FULL_PERMISSIONS,
  hikari: [
    "media:read", "media:create", "media:update", "tags:read", "bangumi:sync", "airing:read",
    "gallery:read", "gallery:create", "gallery:update",
    "video:read", "video:create", "video:update",
    "storage:read", "storage:create", "storage:update",
  ],
  codex: FULL_PERMISSIONS,
  chatgpt: [
    "media:read", "media:create", "media:update", "tags:read",
    "devices:read", "devices:create", "devices:update",
    "gallery:read", "gallery:create", "gallery:update",
    "video:read", "video:create", "video:update",
    "storage:read", "storage:create", "storage:update",
  ],
};

// Only server-created Request objects can carry this identity. No HTTP header,
// browser cookie or existing Agent token can impersonate a ChatGPT connection.
const contentRequests = new WeakMap<Request, AgentIdentity>();

export function createChatGPTContentRequest(userKey: string, url: string | URL, init?: RequestInit) {
  const request = new Request(url, init);
  if (userKey !== getCurrentUser(request)) throw new Error("内容连接的用户归属不匹配");
  contentRequests.set(request, { agent: "chatgpt", userKey, source: "openclaw" });
  return request;
}

type AgentRuntimeEnv = typeof env & {
  YUEXIAJI_NOVA_TOKEN?: string;
  YUEXIAJI_HIKARI_TOKEN?: string;
  YUEXIAJI_CODEX_TOKEN?: string;
};

function configuredTokens() {
  const runtimeEnv = env as AgentRuntimeEnv;
  return [
    ["nova", runtimeEnv.YUEXIAJI_NOVA_TOKEN],
    ["hikari", runtimeEnv.YUEXIAJI_HIKARI_TOKEN],
    ["codex", runtimeEnv.YUEXIAJI_CODEX_TOKEN],
  ] as const;
}

function errorResponse(error: string, status: number, headers?: HeadersInit) {
  return Response.json({ error }, { status, headers: { "cache-control": "no-store", ...headers } });
}

/** Authenticate an Agent using Authorization: Bearer <token> or X-Agent-Token. */
export function authenticateAgent(request: Request): AgentIdentity | Response {
  const contentIdentity = contentRequests.get(request);
  if (contentIdentity) return contentIdentity;
  const authorization = request.headers.get("authorization") || "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  const token = bearer || request.headers.get("x-agent-token")?.trim();
  if (!token) return errorResponse("缺少 Agent Token", 401, { "www-authenticate": "Bearer" });

  const match = configuredTokens().find(([, configured]) => Boolean(configured && configured.trim() && configured.trim() === token));
  if (!match) return errorResponse("Agent Token 无效", 401, { "www-authenticate": "Bearer" });
  return { agent: match[0], userKey: getCurrentUser(request), source: "openclaw" };
}

export function hasAgentPermission(identity: AgentIdentity, permission: AgentPermission) {
  return PERMISSIONS[identity.agent].includes(permission);
}

export function requireAgentPermission(identity: AgentIdentity, permission: AgentPermission) {
  return hasAgentPermission(identity, permission) ? null : errorResponse("当前 Agent 没有执行此操作的权限", 403);
}

export function agentPermissions(identity: AgentIdentity) {
  return [...PERMISSIONS[identity.agent]];
}

export function isAgentIdentity(value: AgentIdentity | Response): value is AgentIdentity {
  return "agent" in value;
}

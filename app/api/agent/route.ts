import { authenticateAgent, agentPermissions, isAgentIdentity } from "../../lib/agent-auth";

export async function GET(request: Request) {
  const identity = authenticateAgent(request);
  if (!isAgentIdentity(identity)) return identity;
  return Response.json({
    ok: true,
    source: identity.source,
    agent: identity.agent,
    user: identity.userKey,
    permissions: agentPermissions(identity),
    uploadWarnings: {
      code: "duplicate_file",
      match: "sha256",
      instruction: "上传响应带 warnings 时必须向用户报告；skipped=true 表示复用当前条目的已有图片，skipped=false 表示仍完成保存。不同条目不会自动合并。",
    },
    endpoints: {
      operations: "/api/agent/operations",
      media: "/api/agent/media",
      devices: "/api/agent/devices",
      tags: "/api/agent/tags",
      gallery: "/api/agent/gallery",
      galleryUpload: "/api/agent/gallery/upload",
      video: "/api/agent/video",
      storage: "/api/agent/storage",
      bangumiSync: "/api/agent/sync",
      animeAiring: "/api/agent/anime/airing",
    },
  }, { headers: { "cache-control": "no-store" } });
}

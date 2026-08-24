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
    endpoints: {
      media: "/api/agent/media",
      devices: "/api/agent/devices",
      tags: "/api/agent/tags",
      gallery: "/api/agent/gallery",
      galleryUpload: "/api/agent/gallery/upload",
      video: "/api/agent/video",
      bangumiSync: "/api/agent/sync",
    },
  }, { headers: { "cache-control": "no-store" } });
}

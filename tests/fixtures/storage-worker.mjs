import * as operations from "../../app/api/agent/operations/route.ts";
import { authenticateAgent, isAgentIdentity } from "../../app/lib/agent-auth.ts";
import { reserveAgentOperation, finishAgentOperation } from "../../app/lib/agent-operations.ts";
import * as storage from "../../app/api/agent/storage/route.ts";
import * as media from "../../app/api/agent/media/route.ts";
import * as devices from "../../app/api/agent/devices/route.ts";
import * as tags from "../../app/api/agent/tags/route.ts";
import * as browserStorage from "../../app/api/media/storage/route.ts";
import { handleAgentAsset } from "../../app/lib/agent-media-assets.ts";

// Only used by the isolated test Worker, never by the deployment entrypoint.
const worker = {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/__test/sql") {
      const statements = await request.json();
      await env.DB.batch(statements.map((statement) => env.DB.prepare(statement)));
      return Response.json({ ok: true });
    }
    if (path === "/__test/reserve") {
      const identity = authenticateAgent(request);
      if (!isAgentIdentity(identity)) return identity;
      const body = await request.json();
      const reservation = await reserveAgentOperation(identity, { request, body, resource: "fixture", action: "create" });
      return reservation.kind === "reserved" ? Response.json(reservation) : reservation.response;
    }
    if (path === "/__test/finish") {
      const { id, status, payload, retrySafe } = await request.json();
      await finishAgentOperation(id, status, payload, { retrySafe });
      return Response.json({ ok: true });
    }
    if (path === "/api/agent/gallery") return handleAgentAsset(request, "visual");
    if (path === "/api/agent/video") return handleAgentAsset(request, "video");
    const routes = { "/api/agent/operations": operations, "/api/agent/storage": storage, "/api/agent/media": media, "/api/agent/devices": devices, "/api/agent/tags": tags, "/api/media/storage": browserStorage };
    return routes[path]?.[request.method]?.(request) ?? new Response("Not found", { status: 404 });
  },
};
export default worker;

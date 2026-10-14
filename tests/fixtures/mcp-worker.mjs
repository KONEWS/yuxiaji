import { hashPassword, createSession } from "../../app/lib/admin-auth.ts";
import { handleMcpOAuth } from "../../app/lib/mcp-oauth.ts";
import { handleMcpRequest } from "../../app/lib/mcp-server.ts";
import * as media from "../../app/api/agent/media/route.ts";
import * as devices from "../../app/api/agent/devices/route.ts";

// This entrypoint and its setup endpoints only run in a nonpersistent local
// test Worker. They are never imported by the production Worker.
globalThis.fetch = async () => { throw new Error("Network access is disabled in the isolated MCP fixture"); };

const worker = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/__test/sql") {
      const statements = await request.json();
      await env.DB.batch(statements.map((statement) => env.DB.prepare(statement)));
      return Response.json({ ok: true });
    }
    if (url.pathname === "/__test/query") {
      const { statement, params = [] } = await request.json();
      return Response.json((await env.DB.prepare(statement).bind(...params).all()).results);
    }
    if (url.pathname === "/__test/setup") {
      const now = Date.now();
      await env.DB.prepare("INSERT INTO admin_account (id,username,password_hash,created_at,updated_at) VALUES (1,?,?,?,?)")
        .bind("mcp-test-admin", await hashPassword("fixture-only-admin-password"), now, now).run();
      const { cookie } = await createSession(request, 1, 86400);
      return Response.json({ origin: url.origin }, { headers: { "set-cookie": cookie } });
    }
    if (url.pathname === "/__test/session") {
      const { cookie } = await createSession(request, 1, 86400);
      return Response.json({ ok: true }, { headers: { "set-cookie": cookie } });
    }
    const oauth = await handleMcpOAuth(request);
    if (oauth) return oauth;
    if (url.pathname === "/mcp") return handleMcpRequest(request);
    const routes = { "/api/agent/media": media, "/api/agent/devices": devices };
    return routes[url.pathname]?.[request.method]?.(request) ?? new Response("Not found", { status: 404 });
  },
};
export default worker;

import * as airing from "../../app/api/agent/anime/airing/route.ts";
import * as capabilities from "../../app/api/agent/route.ts";
import { encryptCredential } from "../../app/lib/bangumi-account.ts";

let upstream = { status: 200, body: [] };
let upstreamCall;
// This isolated Worker cannot contact the real upstream or disclose a test
// credential. It observes only whether the expected header was supplied.
globalThis.fetch = async (url, options) => {
  // Validate options with the real workerd Request implementation even though
  // the network response is mocked (redirect: "error" is unsupported there).
  new Request(url, options);
  const destination = new URL(url);
  if (destination.origin !== "https://animeschedule.net" || destination.pathname !== "/api/v3/timetables/raw") throw new Error("Unexpected upstream");
  upstreamCall = {
    url: destination.toString(),
    authenticated: options.headers.authorization === "Bearer isolated-animeschedule-token",
    redirect: options.redirect,
  };
  if (upstream.reject) throw new Error("request failed isolated-animeschedule-token");
  return Response.json(upstream.body, { status: upstream.status });
};

const worker = {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/__test/sql") {
      const statements = await request.json();
      await env.DB.batch(statements.map((statement) => env.DB.prepare(statement)));
      return Response.json({ ok: true });
    }
    if (path === "/__test/credential") {
      const { enabled } = await request.json();
      await env.DB.prepare("DELETE FROM external_service_credentials WHERE provider='animeschedule'").run();
      if (enabled) {
        const encrypted = await encryptCredential("isolated-animeschedule-token");
        await env.DB.prepare("INSERT INTO external_service_credentials (provider,admin_id,token_ciphertext,metadata,created_at,updated_at) VALUES ('animeschedule',1,?,'{}',1,1)").bind(encrypted).run();
      }
      return Response.json({ ok: true });
    }
    if (path === "/__test/upstream") {
      upstream = await request.json();
      upstreamCall = undefined;
      return Response.json({ ok: true });
    }
    if (path === "/__test/observed") return Response.json(upstreamCall ?? null);
    if (path === "/api/agent") return capabilities.GET(request);
    if (path === "/api/agent/anime/airing") return airing[request.method]?.(request) ?? new Response("Method not allowed", { status: 405 });
    return new Response("Not found", { status: 404 });
  },
};
export default worker;

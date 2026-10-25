import * as state from "../../app/api/state/route.ts";
import * as sync from "../../app/api/bangumi/account/sync/route.ts";
import { createSession } from "../../app/lib/admin-auth.ts";
import { encryptBangumiToken } from "../../app/lib/bangumi-account.ts";

// This nonpersistent test entrypoint never calls the real Bangumi API.
let collections = [];
let writes = [];
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input);
  if (url.origin !== "https://api.bgm.tv") throw new Error("External network disabled in test fixture");
  if (url.pathname === "/v0/users/fixture/collections" && (!init.method || init.method === "GET")) {
    const offset = Number(url.searchParams.get("offset"));
    const limit = Number(url.searchParams.get("limit"));
    return Response.json({ data: collections.slice(offset, offset + limit) });
  }
  const match = /^\/v0\/users\/-\/collections\/(\d+)$/.exec(url.pathname);
  if (match && init.method === "POST") {
    const body = JSON.parse(init.body);
    const subjectId = Number(match[1]);
    const collection = collections.find((item) => item.subject_id === subjectId);
    if (!collection) throw new Error("Unexpected fixture subject");
    writes.push({ subjectId, body });
    Object.assign(collection, body);
    return new Response(null, { status: 204 });
  }
  throw new Error(`Unexpected fixture upstream: ${url.pathname}`);
};

const preferencesSyncWorker = {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/__test/sql") {
      const statements = await request.json();
      await env.DB.batch(statements.map((statement) => env.DB.prepare(statement)));
      return Response.json({ ok: true });
    }
    if (path === "/__test/query") {
      const { statement } = await request.json();
      return Response.json((await env.DB.prepare(statement).all()).results);
    }
    if (path === "/__test/setup") {
      await env.DB.prepare("INSERT INTO admin_account (id,username,password_hash,created_at,updated_at) VALUES (1,'fixture','unused',1,1)").run();
      await env.DB.prepare("INSERT INTO bangumi_account (admin_id,bangumi_user_id,username,token_ciphertext,created_at,updated_at) VALUES (1,123,'fixture',?,1,1)")
        .bind(await encryptBangumiToken("isolated-fixture-token")).run();
      const { cookie } = await createSession(request, 1, 86400);
      return Response.json({ ok: true }, { headers: { "set-cookie": cookie } });
    }
    if (path === "/__test/upstream") {
      collections = await request.json();
      writes = [];
      return Response.json({ ok: true });
    }
    if (path === "/__test/writes") return Response.json(writes);
    if (path === "/api/state") return state[request.method]?.(request) ?? new Response("Method not allowed", { status: 405 });
    if (path === "/api/bangumi/account/sync") return sync[request.method]?.(request) ?? new Response("Method not allowed", { status: 405 });
    return new Response("Not found", { status: 404 });
  },
};

export default preferencesSyncWorker;

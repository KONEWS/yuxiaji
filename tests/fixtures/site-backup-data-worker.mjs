import * as collectionExport from "../../app/api/backup/export/route.ts";
import * as collectionImport from "../../app/api/backup/import/route.ts";
import { createSession } from "../../app/lib/admin-auth.ts";
import {
  exportSiteBackup,
  parseSiteBackup,
  restoreSiteBackup,
  siteBackupFingerprint,
} from "../../app/lib/site-backup-data.ts";

// Only this isolated, non-persistent fixture exposes SQL or a race injector.
// It is never included in the application Worker or production configuration.
const testWorker = {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/__test/setup") {
        await env.DB.prepare("INSERT INTO admin_account (id,username,password_hash,created_at,updated_at) VALUES (1,'fixture','excluded-password-hash',1,1)").run();
        const { cookie } = await createSession(request, 1, 86400);
        return Response.json({ ok: true }, { headers: { "set-cookie": cookie } });
      }
      if (url.pathname === "/__test/sql") {
        const statements = await request.json();
        const results = await env.DB.batch(statements.map((statement) => typeof statement === "string"
          ? env.DB.prepare(statement)
          : env.DB.prepare(statement.sql).bind(...(statement.params ?? []))));
        return Response.json({ results });
      }
      if (url.pathname === "/__test/site/export") {
        return Response.json(await exportSiteBackup(env.DB, env.DEFAULT_USER_ID));
      }
      if (url.pathname === "/__test/site/parse") {
        return Response.json(parseSiteBackup(await request.json()));
      }
      if (url.pathname === "/__test/site/fingerprint") {
        return Response.json({ fingerprint: await siteBackupFingerprint(await request.json()) });
      }
      if (url.pathname === "/__test/site/restore") {
        const body = await request.json();
        await restoreSiteBackup(env.DB, env.DEFAULT_USER_ID, body.backup, body.expectedCurrent);
        return Response.json({ ok: true });
      }
      if (url.pathname === "/__test/site/restore-with-race") {
        const body = await request.json();
        const statementSql = new WeakMap();
        let raced = false;
        // Inject the edit after all application-side preparation/reads, at the
        // boundary immediately before the actual transactional write batch.
        const racingDatabase = {
          prepare(text) {
            const statement = env.DB.prepare(text);
            const originalBind = statement.bind.bind(statement);
            statementSql.set(statement, text);
            statement.bind = (...values) => {
              const bound = originalBind(...values);
              statementSql.set(bound, text);
              return bound;
            };
            return statement;
          },
          async batch(statements) {
            if (!raced && statements.some((statement) => /\b(?:INSERT|DELETE|UPDATE)\b/i.test(statementSql.get(statement) ?? ""))) {
              raced = true;
              await env.DB.prepare("UPDATE user_devices SET review='concurrent edit before commit' WHERE user_key=? AND id=401")
                .bind(env.DEFAULT_USER_ID).run();
            }
            return env.DB.batch(statements);
          },
        };
        try {
          await restoreSiteBackup(racingDatabase, env.DEFAULT_USER_ID, body.backup, body.expectedCurrent);
          return Response.json({ ok: true, raced });
        } catch (error) {
          return Response.json({ error: error.message, code: error.code, raced }, { status: error.status ?? 500 });
        }
      }
      if (url.pathname === "/api/backup/export") return collectionExport.GET(request);
      if (url.pathname === "/api/backup/import") return collectionImport.POST(request);
      return new Response("Not found", { status: 404 });
    } catch (error) {
      return Response.json({ error: error.message, code: error.code }, { status: error.status ?? 500 });
    }
  },
};

export default testWorker;

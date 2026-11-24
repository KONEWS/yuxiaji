import { createHash } from "node:crypto";
import { runBaiduBackup } from "../../app/lib/baidu-scheduled-backup.ts";
import * as archives from "../../app/api/backup/archives/route.ts";
import * as archive from "../../app/api/backup/archive/route.ts";
import * as providers from "../../app/api/backup/providers/route.ts";
import * as baidu from "../../app/api/backup/providers/baidu/route.ts";
import { finishBaiduBackupOAuth } from "../../app/lib/baidu-backup-oauth.ts";
import * as mediaAssets from "../../app/api/media-assets/route.ts";
import * as deviceAssets from "../../app/api/device-assets/route.ts";
import * as avatar from "../../app/api/avatar/route.ts";
import * as background from "../../app/api/background/route.ts";
import { createSession } from "../../app/lib/admin-auth.ts";
import { backupSha256, downloadBackupArchive, listBackupArchives, parseArchiveManifest, runScheduledBackup } from "../../app/lib/backup-archive.ts";
import { exportSiteBackup, parseSiteBackup, siteBackupFingerprint } from "../../app/lib/site-backup-data.ts";

// This fixture only runs against ephemeral local D1/R2 bindings.
const testWorker = {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/__test/setup") {
        await env.DB.prepare("INSERT INTO admin_account (id,username,password_hash,created_at,updated_at) VALUES (1,'fixture','not-a-real-password',1,1)").run();
        const { cookie } = await createSession(request, 1, 86400);
        return Response.json({ ok: true }, { headers: { "set-cookie": cookie } });
      }
      if (url.pathname === "/__test/sql") {
        const statements = await request.json();
        return Response.json({ results: await env.DB.batch(statements.map((statement) => typeof statement === "string"
          ? env.DB.prepare(statement) : env.DB.prepare(statement.sql).bind(...(statement.params ?? [])))) });
      }
      if (url.pathname === "/__test/object") {
        const key = url.searchParams.get("key");
        if (request.method === "PUT") {
          await env.BUCKET.put(key, await request.arrayBuffer(), { httpMetadata: { contentType: request.headers.get("content-type") || "application/octet-stream" } });
          return Response.json({ ok: true });
        }
        if (request.method === "DELETE") {
          await env.BUCKET.delete(key);
          return Response.json({ ok: true });
        }
        const object = await env.BUCKET.get(key);
        if (!object) return new Response("Not found", { status: 404 });
        return new Response(object.body, { headers: { "content-type": object.httpMetadata?.contentType || "application/octet-stream" } });
      }
      if (url.pathname === "/__test/objects") {
        const prefix = url.searchParams.get("prefix") || "";
        let cursor;
        const keys = [];
        do {
          const result = await env.BUCKET.list({ prefix, cursor });
          keys.push(...result.objects.map((object) => object.key));
          cursor = result.truncated ? result.cursor : undefined;
        } while (cursor);
        if (request.method === "DELETE" && keys.length) await env.BUCKET.delete(keys);
        return Response.json({ keys });
      }
      if (url.pathname === "/__test/data") {
        const data = await exportSiteBackup(env.DB, env.DEFAULT_USER_ID);
        return Response.json({ data, fingerprint: await siteBackupFingerprint(data) });
      }
      if (url.pathname === "/__test/baidu-copy") {
        const { now } = await request.json();
        const calls = [];
        const realFetch = globalThis.fetch;
        globalThis.fetch = async (input, init) => {
          const url = new URL(input);
          const method = url.searchParams.get("method");
          if (url.pathname.endsWith("/token")) return Response.json({ access_token: "test", refresh_token: "test", expires_in: 86400 });
          if (method === "upload") {
            calls.push("block");
            const bytes = await init.body.get("file").arrayBuffer();
            return Response.json({ md5: createHash("md5").update(new Uint8Array(bytes)).digest("hex") });
          }
          const path = init.body.get("path");
          if (init.body.get("isdir") === "1") {
            calls.push("mkdir");
            return Response.json({ fs_id: 1, path });
          }
          calls.push(method);
          if (method === "precreate") return Response.json({ uploadid: "test", block_list: [0] });
          return Response.json({ path, fs_id: 2, size: Number(init.body.get("size")) });
        };
        try { await runBaiduBackup(env, now); } finally { globalThis.fetch = realFetch; }
        return Response.json({ calls });
      }
      if (url.pathname === "/__test/cron") {
        const body = await request.json();
        const injectedError = new Error("injected D1 snapshot batch failure");
        const database = body.failBatch ? {
          prepare: env.DB.prepare.bind(env.DB),
          async batch() { throw injectedError; },
        } : env.DB;
        try {
          await runScheduledBackup({ ...env, DB: database, ...(body.componentEnabled === undefined ? {} : { BACKUP_COMPONENT_ENABLED: body.componentEnabled }) }, new Date(body.now));
        } catch (error) {
          if (!body.failBatch) throw error;
          return Response.json({ error: error.message, sameError: error === injectedError }, { status: 500 });
        }
        return Response.json({ ok: true });
      }
      if (url.pathname === "/__test/split-download") {
        const body = await request.json();
        const data = parseSiteBackup(body.data);
        const manifest = await parseArchiveManifest({
          format: "yuexiaji-archive", version: 1, createdAt: "2026-11-25T00:00:00.000Z",
          data, dataSha256: await siteBackupFingerprint(data), assets: body.assets,
        }, env.DEFAULT_USER_ID);
        const prefix = `backups-v2/${await backupSha256(env.DEFAULT_USER_ID)}/`;
        const id = "split-archive-000001";
        const key = `${prefix}records/${id}.json`;
        const record = {
          id, createdAt: manifest.createdAt, kind: "manual", status: "complete", counts: data.counts,
          assetCount: manifest.assets.length, assetBytes: manifest.assets.reduce((sum, asset) => sum + asset.size, 0),
          processedAssets: manifest.assets.length, totalAssets: manifest.assets.length, sources: [], manifest,
        };
        const blobs = new Map(body.blobs.map(([hash, bytes]) => [`${prefix}blobs/${hash}`, new Uint8Array(bytes)]));
        let reads = 0; let assetReads = 0;
        // The independent fake bucket counts the production download function's
        // actual reads while returning real streams and a validated manifest.
        const bucket = {
          async get(requestedKey) {
            reads++;
            if (requestedKey === key) return { etag: "split-fixture", json: async () => structuredClone(record) };
            assetReads++;
            const bytes = blobs.get(requestedKey);
            return bytes ? { size: bytes.length, body: new Blob([bytes]).stream() } : null;
          },
          async list() { return { objects: [{ key }], truncated: false }; },
        };
        const [summary] = await listBackupArchives(bucket, env.DEFAULT_USER_ID);
        reads = 0; assetReads = 0;
        const response = await downloadBackupArchive({ ...env, BUCKET: bucket }, env.DEFAULT_USER_ID, id, "zip", body.part);
        const bytes = await response.arrayBuffer();
        const headers = new Headers(response.headers);
        headers.set("x-test-asset-reads", String(assetReads));
        headers.set("x-test-total-reads", String(reads));
        headers.set("x-test-download-parts", String(summary.downloadParts));
        return new Response(bytes, { status: response.status, headers });
      }
      if (url.pathname === "/api/backup/providers/baidu" && request.method === "GET") {
        return finishBaiduBackupOAuth(request, async (endpoint, init) => {
          const outbound = new Request(endpoint, init);
          const tokenUrl = new URL(outbound.url);
          if (tokenUrl.origin + tokenUrl.pathname !== "https://openapi.baidu.com/oauth/2.0/token" || outbound.method !== "GET" || outbound.redirect !== "manual" || tokenUrl.searchParams.get("client_secret") !== "fixtureSecret" || tokenUrl.searchParams.get("code") !== "fixtureCode") {
            return Response.json({ error: "invalid_grant" }, { status: 400 });
          }
          return Response.json({ access_token: "fixtureAccess", refresh_token: "fixtureRefresh", expires_in: 3600, scope: "basic netdisk" });
        });
      }
      const routes = {
        "/api/backup/providers": providers, "/api/backup/providers/baidu": baidu,
        "/api/backup/archives": archives, "/api/backup/archive": archive,
        "/api/media-assets": mediaAssets, "/api/device-assets": deviceAssets,
        "/api/avatar": avatar, "/api/background": background,
      };
      return routes[url.pathname]?.[request.method]?.(request) ?? new Response("Not found", { status: 404 });
    } catch (error) {
      return Response.json({ error: error.message, code: error.code, rolledBack: error.rolledBack }, { status: error.status ?? 500 });
    }
  },
};

export default testWorker;

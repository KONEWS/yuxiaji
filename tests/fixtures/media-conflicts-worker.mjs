import * as media from "../../app/api/media/route.ts";
import * as devices from "../../app/api/devices/route.ts";
import { cleanupDeletedGalleryAssets } from "../../app/lib/gallery-images.ts";
import { handleAgentAsset } from "../../app/lib/agent-media-assets.ts";
import { mediaAssetObjectKey } from "../../app/lib/media-storage.ts";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../db/index.ts";
import { userSubjects, userSubjectImages } from "../../db/schema.ts";
import { MediaConflictError, mediaSnapshotSelection, writeMediaSnapshot } from "../../app/lib/media-revisions.ts";

// This entrypoint is exclusively used by isolated, non-persistent tests.
const testWorker = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/__test/sql") {
      const statements = await request.json();
      const results = await env.DB.batch(statements.map((statement) => env.DB.prepare(statement)));
      return Response.json({ results });
    }
    if (url.pathname === "/__test/asset") {
      const key = await mediaAssetObjectKey(url.searchParams.get("url"), env.DEFAULT_USER_ID);
      if (!key) return Response.json({ error: "Invalid test asset" }, { status: 400 });
      if (request.method === "POST") await env.BUCKET.put(key, "test image bytes");
      return Response.json({ exists: Boolean(await env.BUCKET.head(key)) });
    }
    if (url.pathname === "/__test/cleanup") {
      await cleanupDeletedGalleryAssets(getDb(), env.DEFAULT_USER_ID, await request.json());
      return Response.json({ ok: true });
    }
    if (url.pathname === "/__test/stale-snapshot") {
      const { id, imageUrl } = await request.json();
      const db = getDb();
      const where = and(eq(userSubjects.id, id), eq(userSubjects.userKey, env.DEFAULT_USER_ID));
      const [original] = await db.select(mediaSnapshotSelection).from(userSubjects).where(where);
      if (!original) return new Response("Not found", { status: 404 });
      // Reproduce an Agent commit after the browser's snapshot was read,
      // but before its transactional guard and mutation batch execute.
      await db.insert(userSubjectImages).values({
        userKey: env.DEFAULT_USER_ID, subjectId: id, thumbnail: imageUrl,
        sortOrder: 1, createdAt: original.updatedAt, updatedAt: original.updatedAt,
      });
      try {
        await writeMediaSnapshot(db, env.DEFAULT_USER_ID, id, original.snapshot, [
          db.update(userSubjects).set({ title: "Must not commit" }).where(where),
          db.delete(userSubjectImages).where(and(eq(userSubjectImages.subjectId, id), eq(userSubjectImages.userKey, env.DEFAULT_USER_ID))),
        ]);
        return Response.json({ ok: true });
      } catch (error) {
        if (error instanceof MediaConflictError) return Response.json({ code: "media_conflict" }, { status: 409 });
        throw error;
      }
    }
    if (url.pathname === "/api/agent/gallery") return handleAgentAsset(request, "visual");
    if (url.pathname === "/api/devices") return devices[request.method]?.(request) ?? new Response("Method not allowed", { status: 405 });
    if (url.pathname === "/api/media") return media[request.method]?.(request) ?? new Response("Method not allowed", { status: 405 });
    return new Response("Not found", { status: 404 });
  },
};

export default testWorker;

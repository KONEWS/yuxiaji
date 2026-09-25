import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { userSubjects } from "../../../../db/schema";
import { getCurrentUser } from "../../../lib/current-user";
import {
  appendGalleryImage,
  galleryImagesForSubject,
  presentGalleryImage,
  removeGalleryImage,
  syncGalleryImages,
} from "../../../lib/gallery-images";

function positiveId(value: unknown) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function subjectFor(db: ReturnType<typeof getDb>, userKey: string, value: unknown) {
  const id = positiveId(value);
  if (!id) return null;
  const [subject] = await db.select({ id: userSubjects.id }).from(userSubjects).where(and(
    eq(userSubjects.id, id),
    eq(userSubjects.userKey, userKey),
    eq(userSubjects.type, "visual"),
  )).limit(1);
  return subject || null;
}

async function jsonBody(request: Request) {
  try {
    const value = await request.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const userKey = getCurrentUser();
  const db = getDb();
  const subject = await subjectFor(db, userKey, new URL(request.url).searchParams.get("subjectId"));
  if (!subject) return Response.json({ error: "画廊记录不存在或无权访问" }, { status: 404 });
  const rows = await galleryImagesForSubject(db, userKey, subject.id);
  return Response.json({ images: rows.map(presentGalleryImage), subjectId: subject.id }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  const userKey = getCurrentUser();
  const body = await jsonBody(request);
  if (!body) return Response.json({ error: "请求体必须是 JSON 对象" }, { status: 400 });
  const db = getDb();
  const subject = await subjectFor(db, userKey, body.subjectId ?? body.id);
  if (!subject) return Response.json({ error: "画廊记录不存在或无权修改" }, { status: 404 });
  try {
    const values = Array.isArray(body.images) ? body.images : [body.image || body];
    const added = [];
    for (const value of values) {
      const result = await appendGalleryImage(db, userKey, subject.id, value);
      if (!result.duplicate) added.push(result.image);
    }
    const rows = await galleryImagesForSubject(db, userKey, subject.id);
    return Response.json({ ok: true, subjectId: subject.id, added: added.map(presentGalleryImage), images: rows.map(presentGalleryImage) }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "添加画廊图片失败" }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  const userKey = getCurrentUser();
  const body = await jsonBody(request);
  if (!body) return Response.json({ error: "请求体必须是 JSON 对象" }, { status: 400 });
  const db = getDb();
  const subject = await subjectFor(db, userKey, body.subjectId ?? body.id);
  if (!subject) return Response.json({ error: "画廊记录不存在或无权修改" }, { status: 404 });
  if (!Array.isArray(body.images)) return Response.json({ error: "images 必须是数组" }, { status: 400 });
  try {
    const rows = await syncGalleryImages(db, userKey, subject.id, body.images) || [];
    return Response.json({ ok: true, subjectId: subject.id, images: rows.map(presentGalleryImage) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "保存画廊图片失败" }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  const userKey = getCurrentUser();
  const id = positiveId(new URL(request.url).searchParams.get("id"));
  if (!id) return Response.json({ error: "缺少图片 id" }, { status: 400 });
  try {
    const result = await removeGalleryImage(getDb(), userKey, id);
    if (!result) return Response.json({ error: "图片不存在或无权删除" }, { status: 404 });
    return Response.json({ ok: true, subjectId: result.subjectId, images: result.images.map(presentGalleryImage) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "删除画廊图片失败" }, { status: 500 });
  }
}

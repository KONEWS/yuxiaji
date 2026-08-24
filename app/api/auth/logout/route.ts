import { eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { adminSessions } from "../../../../db/schema";
import { csrfFailure, clearSessionCookie, getAdminSession, writeAuthLog } from "../../../lib/admin-auth";

export async function POST(request: Request) {
  const csrf = csrfFailure(request);
  if (csrf) return csrf;
  try {
    const current = await getAdminSession(request);
    if (current) {
      await getDb().delete(adminSessions).where(eq(adminSessions.id, current.session.id));
      await writeAuthLog(request, "session_logout", { username: current.account.username, sessionId: current.session.id });
    }
    return Response.json({ ok: true }, { headers: { "set-cookie": clearSessionCookie(), "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ error: "注销失败", details: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

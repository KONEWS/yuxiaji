import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { getDb } from "../../db";
import { externalServiceCredentials } from "../../db/schema";
import { decryptCredential } from "./bangumi-account";

export const ANIMESCHEDULE_PROVIDER = "animeschedule";

function environmentAnimeScheduleToken() {
  const token = env.ANIMESCHEDULE_TOKEN;
  return typeof token === "string" ? token.trim() : "";
}

export async function getAnimeScheduleCredential() {
  const [saved] = await getDb().select().from(externalServiceCredentials).where(eq(externalServiceCredentials.provider, ANIMESCHEDULE_PROVIDER)).limit(1);
  if (saved) return { token: await decryptCredential(saved.tokenCiphertext), source: "settings" as const, row: saved };
  const token = environmentAnimeScheduleToken();
  return token ? { token, source: "environment" as const, row: null } : { token: "", source: null, row: null };
}

export function hasEnvironmentAnimeScheduleToken() {
  return Boolean(environmentAnimeScheduleToken());
}

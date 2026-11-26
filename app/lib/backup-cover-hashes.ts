import { SiteBackupError, type SiteBackup } from "./site-backup-data";

export type CoverHash = { image: string; sourceHash: string };

function coverUrls(data: SiteBackup) {
  return new Set(data.tables.user_subjects.map(row => row.image)
    .filter((image): image is string => typeof image === "string" && image.startsWith("/api/media-assets?")));
}

export function parseCoverHashes(value: unknown, data: SiteBackup): CoverHash[] {
  const urls = coverUrls(data);
  if (!Array.isArray(value)) throw new SiteBackupError("封面原图校验值列表无效");
  return value.map(row => {
    if (!row || typeof row.image !== "string" || !urls.has(row.image)
        || typeof row.sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(row.sourceHash)
        || Object.keys(row).length !== 2) throw new SiteBackupError("封面原图校验值无效");
    return { image: row.image, sourceHash: row.sourceHash };
  });
}

/** Export only original-byte hashes for covers referenced by the snapshot, never audit payloads. */
export async function backupCoverHashes(db: D1Database, user: string, data: SiteBackup): Promise<CoverHash[]> {
  const urls = [...coverUrls(data)];
  const matches: CoverHash[] = [];
  for (let i = 0; i < urls.length; i += 200) {
    const query = db.prepare(BACKUP_HASH_QUERY).bind(JSON.stringify(urls.slice(i, i + 200)), user, user);
    const rows = await query.all<D1Result<CoverHash>>();
    matches.push(...rows.results.filter(row => typeof row.sourceHash === "string" && /^[a-f0-9]{64}$/.test(row.sourceHash)));
  }
  return matches;
}
const BACKUP_HASH_QUERY = `WITH urls AS (SELECT value FROM json_each(?)),
  receipts AS (SELECT CASE WHEN json_valid(response_json) THEN response_json ELSE '{}' END AS payload
    FROM agent_operations WHERE user_key=? AND resource IN ('music_cover','gallery_asset')
    AND action='upload' AND status_code BETWEEN 200 AND 299)
  SELECT coalesce(json_extract(payload,'$.image'),json_extract(payload,'$.thumbnailUrl')) AS image,
    json_extract(payload,'$.imageHash') AS sourceHash FROM receipts WHERE image IN (SELECT value FROM urls)
  UNION SELECT image, source_hash FROM restored_cover_hashes WHERE user_key=? AND image IN (SELECT value FROM urls)
  ORDER BY image,sourceHash`;

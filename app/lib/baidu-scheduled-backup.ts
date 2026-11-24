import { createHash } from "node:crypto";
import { decryptCredential, encryptCredential } from "./bangumi-account";
import { backupSha256, backupUser, downloadBackupArchive, getBackupSettings, listBackupArchives, withBackupLock, type BackupEnv } from "./backup-archive";
import { isBackupComponentEnabledValue } from "./backup-providers";

const folder = "/apps/备份/月下集备份";
const fileApi = "https://pan.baidu.com/rest/2.0/xpan/file";
const sliceApi = "https://d.pcs.baidu.com/rest/2.0/pcs/superfile2";
const blockSize = 4 * 1024 * 1024;
const interval = 5 * 86400000;

type Credential = { appKey: string; secretKey: string; accessToken: string; refreshToken: string; expiresAt: number };
type Part = { size: number; hashes: string[]; uploadId: string; remaining: number[] };
type Job = { archive: string; date: string; part: number; count: number; transfer?: Part };
type Metadata = { expiresAt: number; nextDue?: number; completed?: string; job?: Job; error?: string; retryAt?: number };
type Row = { token_ciphertext: string; metadata: string };
type Reply = { errno?: number; error_code?: number; path?: string; size?: number; fs_id?: number; uploadid?: string; block_list?: number[]; return_type?: number; md5?: string };
class BaiduFailure extends Error {
  constructor(stage: string, readonly code?: number) { super(stage + (code === undefined ? "" : "（" + code + "）")); }
}

function apiUrl(base: string, values: Record<string, string>) {
  const url = new URL(base);
  url.search = new URLSearchParams(values).toString();
  return url;
}

async function call(url: URL, stage: string, body: FormData | URLSearchParams): Promise<Reply> {
  try {
    const response = await fetch(url, { method: "POST", body, redirect: "manual", signal: AbortSignal.timeout(60000) });
    const data: Reply = await response.json();
    const code = data.errno ?? data.error_code;
    if (!response.ok || (code !== undefined && code !== 0)) throw new BaiduFailure(stage, code ?? response.status);
    return data;
  } catch (error) {
    if (error instanceof BaiduFailure) throw error;
    throw new BaiduFailure(stage + "：网络或响应异常");
  }
}

async function refresh(old: Credential): Promise<Credential> {
  const url = apiUrl("https://openapi.baidu.com/oauth/2.0/token", {
    grant_type: "refresh_token", refresh_token: old.refreshToken, client_id: old.appKey, client_secret: old.secretKey,
  });
  const response = await fetch(url, { redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(15000) });
  const value = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!response.ok || !value.access_token || !value.refresh_token || !(Number(value.expires_in) > 0)) throw new BaiduFailure("百度令牌刷新失败，请重新授权");
  return { ...old, accessToken: value.access_token, refreshToken: value.refresh_token, expiresAt: Date.now() + Number(value.expires_in) * 1000 };
}

async function ensureFolder(token: string) {
  try {
    const result = await call(apiUrl(fileApi, { method: "create", access_token: token }), "创建月下集备份目录失败",
      new URLSearchParams({ path: folder, size: "0", isdir: "1", rtype: "0", block_list: "[]" }));
    if (result.path !== folder || !result.fs_id) throw new BaiduFailure("百度未确认备份目录");
  } catch (error) {
    if (!(error instanceof BaiduFailure && error.code === -8)) throw error;
  }
}

// Stage the same ZIP stream served by the download route. Keep only one block hash in memory.
async function stageZip(env: BackupEnv, user: string, job: Job, key: string) {
  const zip = await downloadBackupArchive(env, user, job.archive, "zip", job.part);
  const size = Number(zip.headers.get("content-length"));
  if (!zip.body || !Number.isSafeInteger(size) || size <= 0) throw new BaiduFailure("ZIP 长度无效");
  const hashes: string[] = [];
  let used = 0;
  let md5 = createHash("md5");
  const hashing = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      let start = 0;
      while (start < chunk.length) {
        const length = Math.min(blockSize - used, chunk.length - start);
        md5.update(chunk.subarray(start, start + length));
        used += length;
        start += length;
        if (used === blockSize) {
          hashes.push(md5.digest("hex"));
          md5 = createHash("md5");
          used = 0;
        }
      }
      controller.enqueue(chunk);
    },
    flush() { if (used) hashes.push(md5.digest("hex")); },
  });
  const fixed = new FixedLengthStream(size);
  await Promise.all([env.BUCKET.put(key, fixed.readable), zip.body.pipeThrough(hashing).pipeTo(fixed.writable)]);
  return { size, hashes };
}

async function advancePart(env: BackupEnv, token: string, user: string, job: Job, key: string) {
  const file = (method: string) => apiUrl(fileApi, { method, access_token: token });
  const path = folder + "/月下集-" + job.date + "-part-" + String(job.part).padStart(2, "0") + "-of-" + job.count + ".zip";
  if (!job.transfer) {
    const staged = await stageZip(env, user, job, key);
    const pre = await call(file("precreate"), "百度预上传失败", new URLSearchParams({
      path, isdir: "0", size: String(staged.size), block_list: JSON.stringify(staged.hashes), autoinit: "1", rtype: "3",
    }));
    if (pre.return_type === 2 && pre.path === path && pre.size === staged.size && pre.fs_id) return true;
    if (!pre.uploadid || !Array.isArray(pre.block_list) || pre.block_list.some(n => !Number.isInteger(n) || n < 0 || n >= staged.hashes.length)) throw new BaiduFailure("百度预上传响应缺少分片信息");
    job.transfer = { ...staged, uploadId: pre.uploadid, remaining: pre.block_list };
  }
  const part = job.transfer;
  for (const n of part.remaining.slice(0, 24)) {
    const length = Math.min(blockSize, part.size - n * blockSize);
    const blob = await env.BUCKET.get(key, { range: { offset: n * blockSize, length } });
    if (!blob) { delete job.transfer; throw new BaiduFailure("暂存 ZIP 缺失，稍后重建"); }
    const form = new FormData();
    form.append("file", new Blob([await blob.arrayBuffer()]), "block");
    const result = await call(apiUrl(sliceApi, { method: "upload", access_token: token, type: "tmpfile", path, uploadid: part.uploadId, partseq: String(n) }), "百度分片上传失败", form);
    if (result.md5?.toLowerCase() !== part.hashes[n]) throw new BaiduFailure("百度分片校验失败");
    part.remaining.shift();
  }
  if (part.remaining.length) return false;
  const result = await call(file("create"), "百度合并 ZIP 失败", new URLSearchParams({
    path, size: String(part.size), isdir: "0", uploadid: part.uploadId, block_list: JSON.stringify(part.hashes), rtype: "3",
  }));
  if (!result.fs_id || result.path !== path || result.size !== part.size) throw new BaiduFailure("百度未确认 ZIP 路径和大小");
  return true;
}

export async function runBaiduBackup(env: BackupEnv, now = Date.now()) {
  if (!isBackupComponentEnabledValue(env.BACKUP_COMPONENT_ENABLED)) return;
  const read = () => env.DB.prepare("SELECT token_ciphertext,metadata FROM external_service_credentials WHERE provider='baidu'").first<Row>();
  const due = (m: Metadata) => (m.retryAt ?? 0) <= now && (m.nextDue ?? 0) <= now;
  const first = await read();
  if (!first || !due(JSON.parse(first.metadata))) return;
  const user = backupUser(env);
  if (!(await getBackupSettings(env.BUCKET, user)).enabled) return;
  await withBackupLock(env.BUCKET, user, async lease => {
    const row = await read();
    if (!row) return;
    const m: Metadata = JSON.parse(row.metadata);
    if (!due(m)) return;
    let ciphertext = row.token_ciphertext;
    const save = async (newCiphertext = ciphertext) => {
      await lease();
      const updated = await env.DB.prepare("UPDATE external_service_credentials SET metadata=?,token_ciphertext=? WHERE provider='baidu' AND token_ciphertext=? AND metadata=?")
        .bind(JSON.stringify(m), newCiphertext, ciphertext, row.metadata).run<D1Result>();
      if (updated.meta.changes !== 1) throw new Error("百度授权或进度已改变");
      row.metadata = JSON.stringify(m);
      ciphertext = newCiphertext;
    };
    try {
      const records = await listBackupArchives(env.BUCKET, user);
      if (m.job && !records.some(a => a.id === m.job?.archive && a.status === "complete")) delete m.job;
      if (!m.job) {
        const archive = records.find(a => a.kind === "scheduled" && a.status === "complete" && a.id !== m.completed);
        if (!archive) return;
        m.job = { archive: archive.id, date: archive.id.replace(/^daily-/, ""), part: 1, count: archive.downloadParts };
      }
      let credential: Credential = JSON.parse(await decryptCredential(ciphertext));
      if (Math.min(m.expiresAt, credential.expiresAt) <= now + 3600000) {
        credential = await refresh(credential);
        m.expiresAt = credential.expiresAt;
        await save(await encryptCredential(JSON.stringify(credential)));
      }
      const job = m.job;
      if (job.part === 1 && !job.transfer) await ensureFolder(credential.accessToken);
      const key = "baidu-backup-staging/" + await backupSha256(user) + "/current.zip";
      const complete = await advancePart(env, credential.accessToken, user, job, key);
      if (complete) {
        delete job.transfer;
        job.part++;
        if (job.part > job.count) {
          m.completed = job.archive;
          m.nextDue = Date.parse(job.date + "T04:00:00+08:00") + interval;
          delete m.job;
        }
      }
      delete m.error;
      delete m.retryAt;
      await save();
      if (complete) await env.BUCKET.delete(key);
    } catch (error) {
      m.error = error instanceof BaiduFailure ? error.message : "网盘备份暂时失败，将自动重试";
      if (error instanceof BaiduFailure && [110,111,-6].includes(error.code ?? 0)) m.expiresAt = 0;
      if (error instanceof BaiduFailure && [31363,31364,31081].includes(error.code ?? 0) && m.job) delete m.job.transfer;
      m.retryAt = now + 5 * 60000;
      await save();
    }
  });
}

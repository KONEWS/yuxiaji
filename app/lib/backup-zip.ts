/** Portable STORE-only ZIP files. Images are already compressed; stream instead of buffering the archive. */
export type ZipSource = { name: string; size: number; stream: ReadableStream<Uint8Array>; crc32?: number };
export type ZipEntry = { name: string; size: number; crc32: number; offset: number; dataOffset: number };
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_FILES = 30000;
const MAX_ARCHIVE = 0xfffffff0;
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});
function updateCrc(crc: number, bytes: Uint8Array) {
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return crc >>> 0;
}
export function backupCrc32(bytes: Uint8Array) { return (updateCrc(0xffffffff, bytes) ^ 0xffffffff) >>> 0; }
function checkName(name: string) {
  if (name !== "backup.json" && !/^assets\/[a-f0-9]{64}$/.test(name)) throw new Error("备份包包含不支持的文件名");
}
function checkSize(name: string, size: number) {
  const max = name === "backup.json" ? 20 * 1024 * 1024 : 8 * 1024 * 1024;
  if (!Number.isSafeInteger(size) || size < 0 || size > max) throw new Error("备份包中的单个文件过大");
}
function header(size: number) { const bytes = new Uint8Array(size); return { bytes, view: new DataView(bytes.buffer) }; }

function centralHeader(name: Uint8Array, size: number, crc: number, start: number, flags: number) {
  const central = header(46 + name.length);
  central.view.setUint32(0, 0x02014b50, true); central.view.setUint16(4, 20, true); central.view.setUint16(6, 20, true);
  central.view.setUint16(8, flags, true); central.view.setUint32(16, crc, true);
  central.view.setUint32(20, size, true); central.view.setUint32(24, size, true);
  central.view.setUint16(28, name.length, true); central.view.setUint32(42, start, true); central.bytes.set(name, 46);
  return central.bytes;
}
function endRecord(count: number, centralOffset: number, size: number) {
  if (size + 22 > MAX_ARCHIVE) throw new Error("备份包超过 4 GB");
  const end = header(22); end.view.setUint32(0, 0x06054b50, true);
  end.view.setUint16(8, count, true); end.view.setUint16(10, count, true);
  end.view.setUint32(12, size - centralOffset, true); end.view.setUint32(16, centralOffset, true);
  return end.bytes;
}

export type ZipRangeIndex = { size: number; images: { offset: number; size: number; sha256: string }[] };

// Store the manifest and ZIP structures contiguously. Content-addressed images fill
// the holes, so any transfer block can be reconstructed without reading earlier images.
export function createZipTemplate(manifest: Uint8Array, manifestCrc: number, assets: { sha256: string; size: number; crc32: number }[]) {
  const fixed: Uint8Array[] = [];
  const directory: Uint8Array[] = [];
  const images: ZipRangeIndex["images"] = [];
  let offset = 0;
  function entry(name: string, size: number, crc: number) {
    checkName(name); checkSize(name, size);
    const bytes = encoder.encode(name);
    const local = header(30 + bytes.length);
    local.view.setUint32(0, 0x04034b50, true); local.view.setUint16(4, 20, true);
    local.view.setUint32(14, crc, true); local.view.setUint32(18, size, true); local.view.setUint32(22, size, true);
    local.view.setUint16(26, bytes.length, true); local.bytes.set(bytes, 30);
    directory.push(centralHeader(bytes, size, crc, offset, 0));
    fixed.push(local.bytes);
    offset += local.bytes.length;
  }
  entry("backup.json", manifest.length, manifestCrc);
  fixed.push(manifest); offset += manifest.length;
  for (const asset of new Map(assets.map(a => [a.sha256, a])).values()) {
    entry("assets/" + asset.sha256, asset.size, asset.crc32);
    images.push({ offset, size: asset.size, sha256: asset.sha256 });
    offset += asset.size;
  }
  if (directory.length > MAX_FILES) throw new Error("备份包文件数量超限");
  const centralOffset = offset;
  for (const bytes of directory) { fixed.push(bytes); offset += bytes.length; }
  fixed.push(endRecord(directory.length, centralOffset, offset));
  return { fixed: new Blob(fixed as BlobPart[]), index: { size: offset + 22, images } };
}

export function createBackupZip(entries: AsyncIterable<ZipSource> | Iterable<ZipSource>): ReadableStream<Uint8Array> {
  async function* generate() {
    const directory: Uint8Array[] = [];
    const names = new Set<string>();
    let offset = 0;
    for await (const entry of entries) {
      checkName(entry.name); checkSize(entry.name, entry.size);
      if (entry.crc32 !== undefined && (!Number.isInteger(entry.crc32) || entry.crc32 < 0 || entry.crc32 > 0xffffffff)) throw new Error("备份文件校验值无效");
      if (names.has(entry.name) || names.size >= MAX_FILES) throw new Error("备份包文件重复或数量超限");
      names.add(entry.name);
      const name = encoder.encode(entry.name);
      const start = offset;
      if (offset + entry.size + name.length + 46 > MAX_ARCHIVE) throw new Error("备份包超过 4 GB，请分开保存");
      const local = header(30 + name.length);
      local.view.setUint32(0, 0x04034b50, true); local.view.setUint16(4, 20, true);
      local.view.setUint16(6, 8, true); local.view.setUint16(26, name.length, true); local.bytes.set(name, 30);
      yield local.bytes; offset += local.bytes.length;
      const reader = entry.stream.getReader();
      let read = 0; let crc = 0xffffffff;
      try {
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          read += chunk.value.byteLength;
          if (read > entry.size) throw new Error("备份图片长度发生变化");
          if (entry.crc32 === undefined) crc = updateCrc(crc, chunk.value);
          offset += chunk.value.byteLength; yield chunk.value;
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      if (read !== entry.size) throw new Error("备份图片读取不完整");
      crc = entry.crc32 ?? ((crc ^ 0xffffffff) >>> 0);
      const descriptor = header(16); descriptor.view.setUint32(0, 0x08074b50, true);
      descriptor.view.setUint32(4, crc, true); descriptor.view.setUint32(8, read, true); descriptor.view.setUint32(12, read, true);
      yield descriptor.bytes; offset += 16;
      directory.push(centralHeader(name, read, crc, start, 8));
    }
    if (!names.has("backup.json")) throw new Error("备份包缺少数据清单");
    const centralOffset = offset;
    for (const bytes of directory) { offset += bytes.length; yield bytes; }
    yield endRecord(names.size, centralOffset, offset);
  }
  const iterator = generate();
  return new ReadableStream({
    async pull(controller) { try { const value = await iterator.next(); if (value.done) controller.close(); else controller.enqueue(value.value); } catch (error) { controller.error(error); } },
    async cancel() { await iterator.return(undefined); },
  });
}

/** Read only the directory and small headers. Individual images are checked when uploaded. */
export async function inspectBackupZip(file: Blob): Promise<ZipEntry[]> {
  if (file.size < 22 || file.size > MAX_ARCHIVE) throw new Error("不是受支持的 ZIP 备份文件");
  const tailOffset = Math.max(0, file.size - 65557);
  const tail = new DataView(await file.slice(tailOffset).arrayBuffer());
  let end = -1;
  for (let n = tail.byteLength - 22; n >= 0; n--) {
    if (tail.getUint32(n, true) === 0x06054b50 && n + 22 + tail.getUint16(n + 20, true) === tail.byteLength) { end = n; break; }
  }
  if (end < 0 || tail.getUint16(end + 4, true) || tail.getUint16(end + 6, true)) throw new Error("不支持分卷 ZIP 备份");
  const count = tail.getUint16(end + 10, true);
  const size = tail.getUint32(end + 12, true); const offset = tail.getUint32(end + 16, true);
  if (!count || count > MAX_FILES || tail.getUint16(end + 8, true) !== count || offset + size !== tailOffset + end || size > MAX_FILES * 256) throw new Error("备份 ZIP 目录损坏");
  const directory = new DataView(await file.slice(offset, offset + size).arrayBuffer());
  const entries: ZipEntry[] = []; const names = new Set<string>();
  let position = 0; let lastEnd = 0;
  for (let i = 0; i < count; i++) {
    if (position + 46 > size || directory.getUint32(position, true) !== 0x02014b50) throw new Error("备份 ZIP 目录损坏");
    const flags = directory.getUint16(position + 8, true); const method = directory.getUint16(position + 10, true);
    const compressed = directory.getUint32(position + 20, true); const bytes = directory.getUint32(position + 24, true);
    const nameLength = directory.getUint16(position + 28, true); const extra = directory.getUint16(position + 30, true); const comment = directory.getUint16(position + 32, true);
    const localOffset = directory.getUint32(position + 42, true); const crc32 = directory.getUint32(position + 16, true);
    if ((flags & ~0x808) || method !== 0 || compressed !== bytes || directory.getUint16(position + 34, true)) throw new Error("仅支持月下集导出的未加密 ZIP 备份");
    if (position + 46 + nameLength + extra + comment > size) throw new Error("备份 ZIP 目录截断");
    const name = decoder.decode(new Uint8Array(directory.buffer, position + 46, nameLength));
    checkName(name); checkSize(name, bytes);
    if (names.has(name)) throw new Error("备份 ZIP 包含重复文件"); names.add(name);
    if (localOffset < lastEnd || localOffset + 30 > offset) throw new Error("备份 ZIP 文件区间重叠");
    const local = new DataView(await file.slice(localOffset, localOffset + 30).arrayBuffer());
    if (local.getUint32(0, true) !== 0x04034b50 || local.getUint16(6, true) !== flags || local.getUint16(8, true) !== 0 || local.getUint16(26, true) !== nameLength) throw new Error("备份 ZIP 文件头不一致");
    const localName = decoder.decode(await file.slice(localOffset + 30, localOffset + 30 + nameLength).arrayBuffer());
    if (localName !== name) throw new Error("备份 ZIP 文件名不一致");
    const dataOffset = localOffset + 30 + nameLength + local.getUint16(28, true);
    let dataEnd = dataOffset + bytes;
    if (dataEnd > offset) throw new Error("备份 ZIP 文件内容截断");
    if (flags & 8) {
      const dd = new DataView(await file.slice(dataEnd, Math.min(dataEnd + 16, offset)).arrayBuffer());
      const signature = dd.byteLength >= 4 && dd.getUint32(0, true) === 0x08074b50 ? 4 : 0;
      if (dd.byteLength < signature + 12 || dd.getUint32(signature, true) !== crc32 || dd.getUint32(signature + 4, true) !== bytes || dd.getUint32(signature + 8, true) !== bytes) throw new Error("备份 ZIP 数据描述符损坏");
      dataEnd += signature + 12;
    } else if (local.getUint32(14, true) !== crc32 || local.getUint32(18, true) !== bytes || local.getUint32(22, true) !== bytes) throw new Error("备份 ZIP 文件大小不一致");
    if (dataEnd > offset) throw new Error("备份 ZIP 文件内容截断");
    entries.push({ name, size: bytes, crc32, offset: localOffset, dataOffset });
    lastEnd = dataEnd; position += 46 + nameLength + extra + comment;
  }
  if (position !== size || !names.has("backup.json")) throw new Error("备份 ZIP 缺少数据清单或目录损坏");
  return entries;
}

export async function readBackupZipEntry(file: Blob, entry: ZipEntry): Promise<Blob> {
  checkName(entry.name); checkSize(entry.name, entry.size);
  const blob = file.slice(entry.dataOffset, entry.dataOffset + entry.size);
  if (blob.size !== entry.size || backupCrc32(new Uint8Array(await blob.arrayBuffer())) !== entry.crc32) throw new Error("备份文件校验失败：" + entry.name);
  return blob;
}

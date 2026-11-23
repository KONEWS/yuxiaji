/** Publish a new numeric image version without replacing an existing object. */
export async function putVersionedImage(bucket: R2Bucket, base: string, bytes: ArrayBuffer, contentType: string, sha256?: string): Promise<number> {
  // Sixteen-digit numeric versions distinguish immutable files from legacy
  // thirteen-digit timestamps that still resolve through a fixed object key.
  const start = Date.now() * 1000;
  for (let attempt = 0; attempt < 16; attempt++) {
    const version = start + attempt;
    const written = await bucket.put(base + "/" + version, bytes, { httpMetadata: { contentType }, onlyIf: { etagDoesNotMatch: "*" }, ...(sha256 ? { sha256 } : {}) });
    if (written) return version;
  }
  throw new Error("图片版本创建冲突，请稍后重试");
}

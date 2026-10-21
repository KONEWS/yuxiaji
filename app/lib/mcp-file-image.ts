/** Only host-provided ChatGPT file references may be downloaded, never record URLs. */
export const MAX_COVER_INPUT_BYTES = 20 * 1024 * 1024;
export const MAX_COVER_OUTPUT_BYTES = 5 * 1024 * 1024;
export type CoverImagesBinding = {
  input(stream: ReadableStream): {
    transform(options: { width: number; fit: "scale-down" }): {
      output(options: { format: "image/webp"; quality: number }): Promise<{ response(): Response }>;
    };
  };
};

export function chatGPTFileUrl(value: unknown) {
  if (typeof value !== "string" || value.length > 8192) throw new Error("文件引用无效");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("文件引用无效"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash ||
    !url.hostname.endsWith(".oaiusercontent.com")) {
    throw new Error("只接受 ChatGPT 提供的文件下载地址，请重新附上图片");
  }
  return url;
}

export function coverImageType(bytes: Uint8Array) {
  const starts = (signature: number[], offset = 0) => signature.every((value, index) => bytes[offset + index] === value);
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
}

export async function boundedImageBytes(response: Response, limit: number) {
  if (!response.ok || !response.body) throw new Error("文件读取失败，请重新附上图片");
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body.cancel();
    throw new Error("图片超过大小限制");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error("图片超过大小限制"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (!size) throw new Error("图片文件为空");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function downloadCoverImage(url: URL, declaredType?: string, fetcher: typeof fetch = fetch) {
  const response = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(20000) });
  const bytes = await boundedImageBytes(response, MAX_COVER_INPUT_BYTES);
  const type = coverImageType(bytes);
  if (!type) throw new Error("封面必须是有效的 JPG、PNG 或 WebP 图片");
  for (const candidate of [declaredType, response.headers.get("content-type")]) {
    const normalized = candidate?.split(";", 1)[0].trim().toLowerCase().replace(/^image\/jpg$/, "image/jpeg");
    if (normalized && normalized !== "application/octet-stream" && normalized !== type) throw new Error("图片内容与 MIME 类型不匹配");
  }
  return { bytes, type };
}

export async function transformCoverImage(bytes: Uint8Array, images: CoverImagesBinding) {
  const transformed = await images.input(new Blob([bytes as Uint8Array<ArrayBuffer>]).stream())
    .transform({ width: 1600, fit: "scale-down" }).output({ format: "image/webp", quality: 82 });
  const output = await boundedImageBytes(transformed.response(), MAX_COVER_OUTPUT_BYTES);
  if (coverImageType(output) !== "image/webp") throw new Error("封面转换失败");
  return output;
}

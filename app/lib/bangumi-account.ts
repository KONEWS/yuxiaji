import { env } from "cloudflare:workers";

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(normalized);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function encryptionKeyMaterial() {
  const value = env.YUEXIAJI_CREDENTIALS_ENCRYPTION_KEY?.trim() || env.BANGUMI_TOKEN_ENCRYPTION_KEY?.trim();
  if (!value) throw new Error("凭据加密密钥未配置");
  return value;
}

async function getKey() {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encryptionKeyMaterial()));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** Encrypt a third-party credential using Worker-compatible AES-GCM. */
export async function encryptCredential(token: string) {
  const value = token.trim();
  if (!value) throw new Error("Bangumi Access Token 不能为空");
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await getKey(),
    new TextEncoder().encode(value),
  );
  return `v1.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(ciphertext))}`;
}

/** Decrypt a versioned third-party credential ciphertext. */
export async function decryptCredential(encoded: string) {
  const [version, ivText, ciphertextText] = encoded.split(".");
  if (version !== "v1" || !ivText || !ciphertextText) throw new Error("Bangumi Token 密文格式无效");
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64UrlToBytes(ivText) },
      await getKey(),
      base64UrlToBytes(ciphertextText),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new Error("Bangumi Token 解密失败，请重新绑定");
  }
}

export const encryptBangumiToken = encryptCredential;
export const decryptBangumiToken = decryptCredential;

const encoder = new TextEncoder();

export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function bytesToBase64Url(value: Uint8Array<ArrayBufferLike>): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(value: string | ArrayBuffer): Promise<string> {
  const input = typeof value === "string" ? encoder.encode(value) : value;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function verifyEd25519(publicKey: string, signature: string, message: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", base64UrlToBytes(publicKey), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, base64UrlToBytes(signature), encoder.encode(message));
  } catch {
    return false;
  }
}

async function importCredentialsKey(secret: string): Promise<CryptoKey> {
  const bytes = base64UrlToBytes(secret);
  if (bytes.byteLength !== 32) throw new Error("CREDENTIALS_KEY must contain 32 bytes of base64url data");
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptJson(value: unknown, secret: string, context: string): Promise<string> {
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: encoder.encode(context) },
    await importCredentialsKey(secret),
    encoder.encode(JSON.stringify(value)),
  );
  return `v1.${bytesToBase64Url(nonce)}.${bytesToBase64Url(new Uint8Array(ciphertext))}`;
}

export async function decryptJson(value: string, secret: string, context: string): Promise<unknown> {
  const [version, nonce, ciphertext, extra] = value.split(".");
  if (version !== "v1" || !nonce || !ciphertext || extra) throw new Error("Invalid encrypted credentials");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64UrlToBytes(nonce), additionalData: encoder.encode(context) },
    await importCredentialsKey(secret),
    base64UrlToBytes(ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
}

export function randomToken(bytes = 32): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return bytesToBase64Url(value);
}

export function randomId(prefix: string): string {
  return `${prefix}_${randomToken(16)}`;
}

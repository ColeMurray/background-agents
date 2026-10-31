/** Purpose-separated AES-GCM; owner/profile AAD prevents moving ciphertext between grants. */
async function key(secret: string) {
  const bytes = Uint8Array.from(atob(secret), (c) => c.charCodeAt(0));
  if (bytes.length !== 32) throw new Error("Invalid MCP encryption key configuration");
  const material = await crypto.subtle.importKey("raw", bytes, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode("open-inspect:mcp:v1"),
      info: new Uint8Array(),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}
export async function encryptMcp(
  value: unknown,
  secret: string,
  binding: readonly unknown[]
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(JSON.stringify(binding)) },
    await key(secret),
    new TextEncoder().encode(JSON.stringify(value))
  );
  const result = new Uint8Array(iv.length + encrypted.byteLength);
  result.set(iv);
  result.set(new Uint8Array(encrypted), iv.length);
  return `v1.${btoa(String.fromCharCode(...result))}`;
}
export async function decryptMcp<T>(
  value: string,
  secret: string,
  binding: readonly unknown[]
): Promise<T> {
  if (!value.startsWith("v1.")) throw new Error("Unsupported MCP ciphertext");
  const bytes = Uint8Array.from(atob(value.slice(3)), (c) => c.charCodeAt(0));
  const plain = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: bytes.slice(0, 12),
      additionalData: new TextEncoder().encode(JSON.stringify(binding)),
    },
    await key(secret),
    bytes.slice(12)
  );
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

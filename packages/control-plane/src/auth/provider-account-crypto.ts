const ALGORITHM = "AES-GCM";
const IV_LENGTH = 12;
const FORMAT_VERSION = "v1";

export interface ProviderAccountCryptoContext {
  providerAccountId: string;
  provider: string;
  credentialSchemaVersion: number;
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function encodeBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function importKey(keyBase64: string): Promise<CryptoKey> {
  const key = decodeBase64(keyBase64);
  if (key.byteLength !== 32) {
    throw new Error("Provider accounts encryption key must contain exactly 32 bytes");
  }
  return crypto.subtle.importKey("raw", key, ALGORITHM, false, ["encrypt", "decrypt"]);
}

function additionalData(context: ProviderAccountCryptoContext): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify([
      FORMAT_VERSION,
      context.providerAccountId,
      context.provider,
      context.credentialSchemaVersion,
    ])
  );
}

export async function encryptProviderAccountPayload(
  payload: unknown,
  encryptionKey: string,
  context: ProviderAccountCryptoContext
): Promise<string> {
  const key = await importKey(encryptionKey);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const serialized = JSON.stringify(payload);
  if (serialized === undefined) throw new Error("Provider credential payload must be JSON encoded");
  const plaintext = new TextEncoder().encode(serialized);
  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv, additionalData: additionalData(context) },
    key,
    plaintext
  );
  return `${FORMAT_VERSION}.${encodeBase64(iv)}.${encodeBase64(new Uint8Array(ciphertext))}`;
}

export async function decryptProviderAccountPayload<T = unknown>(
  encrypted: string,
  encryptionKey: string,
  context: ProviderAccountCryptoContext
): Promise<T> {
  const [version, encodedIv, encodedCiphertext, extra] = encrypted.split(".");
  if (version !== FORMAT_VERSION) {
    throw new Error(`Unsupported provider credential encryption format version: ${version}`);
  }
  if (!encodedIv || !encodedCiphertext || extra !== undefined) {
    throw new Error("Malformed provider credential ciphertext");
  }
  const iv = decodeBase64(encodedIv);
  if (iv.byteLength !== IV_LENGTH) throw new Error("Malformed provider credential IV");
  const plaintext = await crypto.subtle.decrypt(
    { name: ALGORITHM, iv, additionalData: additionalData(context) },
    await importKey(encryptionKey),
    decodeBase64(encodedCiphertext)
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

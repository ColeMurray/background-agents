import { MAX_COMMIT_SIGNING_PRIVATE_KEY_LENGTH } from "@open-inspect/shared";

const OPENSSH_MAGIC = new TextEncoder().encode("openssh-key-v1\0");
const ED25519_KEY_TYPE = "ssh-ed25519";
const ED25519_PUBLIC_KEY_BYTES = 32;
const ED25519_PRIVATE_KEY_BYTES = 64;
const UNENCRYPTED_BLOCK_SIZE = 8;
const ED25519_PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);
const PROBE_MESSAGE = new TextEncoder().encode("open-inspect commit signing key validation");

export interface ValidatedOpenSshEd25519Key {
  keyFormat: "ssh-ed25519";
  publicKey: string;
  fingerprint: string;
}

export class OpenSshKeyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenSshKeyValidationError";
  }
}

class BinaryReader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  readBytes(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.bytes.length) {
      throw new OpenSshKeyValidationError("Invalid OpenSSH private key structure");
    }

    const value = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  readUint32(): number {
    const bytes = this.readBytes(4);
    return (((bytes[0] * 0x100 + bytes[1]) * 0x100 + bytes[2]) * 0x100 + bytes[3]) >>> 0;
  }

  readString(): Uint8Array {
    return this.readBytes(this.readUint32());
  }

  get remaining(): number {
    return this.bytes.length - this.offset;
  }
}

function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new OpenSshKeyValidationError("Invalid OpenSSH private key text field");
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;

  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

function decodePrivateKeyPem(privateKey: string): Uint8Array {
  const normalized = privateKey.replace(/\r\n/g, "\n").trim();
  const match = normalized.match(
    /^-----BEGIN OPENSSH PRIVATE KEY-----\n([A-Za-z0-9+/=\n]+)\n-----END OPENSSH PRIVATE KEY-----$/
  );
  if (!match) throw new OpenSshKeyValidationError("Expected an OpenSSH private key");

  try {
    return Uint8Array.from(atob(match[1].replaceAll("\n", "")), (character) =>
      character.charCodeAt(0)
    );
  } catch {
    throw new OpenSshKeyValidationError("Invalid OpenSSH private key encoding");
  }
}

function parsePublicKeyBlob(publicKeyBlob: Uint8Array): Uint8Array {
  const reader = new BinaryReader(publicKeyBlob);
  if (decodeText(reader.readString()) !== ED25519_KEY_TYPE) {
    throw new OpenSshKeyValidationError("Only Ed25519 signing keys are supported");
  }

  const publicKey = reader.readString();
  if (publicKey.length !== ED25519_PUBLIC_KEY_BYTES || reader.remaining !== 0) {
    throw new OpenSshKeyValidationError("Invalid Ed25519 public key");
  }
  return publicKey;
}

function parsePrivateKeyBlob(privateKeyBlob: Uint8Array): {
  publicKey: Uint8Array;
  seed: Uint8Array;
} {
  const reader = new BinaryReader(privateKeyBlob);
  const firstCheckValue = reader.readUint32();
  const secondCheckValue = reader.readUint32();
  if (firstCheckValue !== secondCheckValue) {
    throw new OpenSshKeyValidationError("Invalid OpenSSH private key check values");
  }
  if (decodeText(reader.readString()) !== ED25519_KEY_TYPE) {
    throw new OpenSshKeyValidationError("Only Ed25519 signing keys are supported");
  }

  const publicKey = reader.readString();
  const privateKey = reader.readString();
  reader.readString(); // comment

  if (
    publicKey.length !== ED25519_PUBLIC_KEY_BYTES ||
    privateKey.length !== ED25519_PRIVATE_KEY_BYTES ||
    !equalBytes(privateKey.slice(ED25519_PUBLIC_KEY_BYTES), publicKey)
  ) {
    throw new OpenSshKeyValidationError("Inconsistent Ed25519 key material");
  }

  const paddingLength = reader.remaining;
  if (
    paddingLength === 0 ||
    paddingLength > UNENCRYPTED_BLOCK_SIZE ||
    privateKeyBlob.length % UNENCRYPTED_BLOCK_SIZE !== 0
  ) {
    throw new OpenSshKeyValidationError("Invalid OpenSSH private key padding");
  }

  const padding = reader.readBytes(paddingLength);
  for (let index = 0; index < padding.length; index += 1) {
    if (padding[index] !== index + 1) {
      throw new OpenSshKeyValidationError("Invalid OpenSSH private key padding");
    }
  }

  return { publicKey, seed: privateKey.slice(0, ED25519_PUBLIC_KEY_BYTES) };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function verifyKeyPair(seed: Uint8Array, publicKey: Uint8Array): Promise<void> {
  const pkcs8 = new Uint8Array(ED25519_PKCS8_PREFIX.length + seed.length);
  pkcs8.set(ED25519_PKCS8_PREFIX);
  pkcs8.set(seed, ED25519_PKCS8_PREFIX.length);

  try {
    const privateCryptoKey = await crypto.subtle.importKey(
      "pkcs8",
      pkcs8,
      { name: "Ed25519" },
      false,
      ["sign"]
    );
    const publicCryptoKey = await crypto.subtle.importKey(
      "raw",
      publicKey,
      { name: "Ed25519" },
      false,
      ["verify"]
    );
    const signature = await crypto.subtle.sign("Ed25519", privateCryptoKey, PROBE_MESSAGE);
    const valid = await crypto.subtle.verify("Ed25519", publicCryptoKey, signature, PROBE_MESSAGE);
    if (!valid) throw new OpenSshKeyValidationError("Inconsistent Ed25519 key material");
  } catch (error) {
    if (error instanceof OpenSshKeyValidationError) throw error;
    throw new OpenSshKeyValidationError("Unable to validate Ed25519 key material");
  }
}

export async function validateOpenSshEd25519PrivateKey(
  privateKey: string
): Promise<ValidatedOpenSshEd25519Key> {
  if (new TextEncoder().encode(privateKey).length > MAX_COMMIT_SIGNING_PRIVATE_KEY_LENGTH) {
    throw new OpenSshKeyValidationError(
      `Signing key exceeds ${MAX_COMMIT_SIGNING_PRIVATE_KEY_LENGTH} bytes`
    );
  }

  const decoded = decodePrivateKeyPem(privateKey);
  const reader = new BinaryReader(decoded);
  if (!equalBytes(reader.readBytes(OPENSSH_MAGIC.length), OPENSSH_MAGIC)) {
    throw new OpenSshKeyValidationError("Invalid OpenSSH private key header");
  }
  if (decodeText(reader.readString()) !== "none" || decodeText(reader.readString()) !== "none") {
    throw new OpenSshKeyValidationError("Encrypted OpenSSH private keys are not supported");
  }
  if (reader.readString().length !== 0 || reader.readUint32() !== 1) {
    throw new OpenSshKeyValidationError("Expected exactly one unencrypted private key");
  }

  const publicKeyBlob = reader.readString();
  const outerPublicKey = parsePublicKeyBlob(publicKeyBlob);
  const privateKeyBlob = reader.readString();
  if (reader.remaining !== 0) {
    throw new OpenSshKeyValidationError("Invalid OpenSSH private key structure");
  }

  const innerKey = parsePrivateKeyBlob(privateKeyBlob);
  if (!equalBytes(innerKey.publicKey, outerPublicKey)) {
    throw new OpenSshKeyValidationError("Inconsistent Ed25519 key material");
  }
  await verifyKeyPair(innerKey.seed, outerPublicKey);

  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", publicKeyBlob));
  return {
    keyFormat: ED25519_KEY_TYPE,
    publicKey: `${ED25519_KEY_TYPE} ${bytesToBase64(publicKeyBlob)}`,
    fingerprint: `SHA256:${bytesToBase64(digest).replace(/=+$/, "")}`,
  };
}

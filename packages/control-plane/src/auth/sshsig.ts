const SSHSIG_MAGIC = new TextEncoder().encode("SSHSIG");
const GIT_NAMESPACE = new TextEncoder().encode("git");
const EMPTY_RESERVED = new Uint8Array();
const SHA512_ALGORITHM = new TextEncoder().encode("sha512");
const ED25519_KEY_TYPE = new TextEncoder().encode("ssh-ed25519");
const SSHSIG_VERSION = 1;
const ARMOR_LINE_LENGTH = 70;

export async function createGitSshSigSignedData(payload: Uint8Array): Promise<Uint8Array> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-512", payload));
  return concatenate(
    SSHSIG_MAGIC,
    encodeSshString(GIT_NAMESPACE),
    encodeSshString(EMPTY_RESERVED),
    encodeSshString(SHA512_ALGORITHM),
    encodeSshString(digest)
  );
}

export function createArmoredGitSshSig(
  publicKeyBlob: Uint8Array,
  rawSignature: Uint8Array
): string {
  const signatureBlob = concatenate(
    encodeSshString(ED25519_KEY_TYPE),
    encodeSshString(rawSignature)
  );
  const sshsig = concatenate(
    SSHSIG_MAGIC,
    encodeUint32(SSHSIG_VERSION),
    encodeSshString(publicKeyBlob),
    encodeSshString(GIT_NAMESPACE),
    encodeSshString(EMPTY_RESERVED),
    encodeSshString(SHA512_ALGORITHM),
    encodeSshString(signatureBlob)
  );
  const base64 = bytesToBase64(sshsig);
  const lines = base64.match(new RegExp(`.{1,${ARMOR_LINE_LENGTH}}`, "g")) ?? [];
  return `-----BEGIN SSH SIGNATURE-----\n${lines.join("\n")}\n-----END SSH SIGNATURE-----\n`;
}

function encodeSshString(value: Uint8Array): Uint8Array {
  const encoded = new Uint8Array(4 + value.length);
  encoded.set(encodeUint32(value.length));
  encoded.set(value, 4);
  return encoded;
}

function encodeUint32(value: number): Uint8Array {
  const encoded = new Uint8Array(4);
  new DataView(encoded.buffer).setUint32(0, value);
  return encoded;
}

function concatenate(...values: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.reduce((length, value) => length + value.length, 0));
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

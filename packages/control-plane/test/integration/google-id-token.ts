const MS_PER_SECOND = 1000;
const GOOGLE_ID_TOKEN_LIFETIME_MS = 5 * 60 * MS_PER_SECOND;

interface GoogleIdTokenClaims {
  readonly sub: string;
  readonly email: string;
  readonly email_verified: boolean;
  readonly name?: string;
  readonly picture?: string;
}

function encodeBase64Url(value: string | Uint8Array): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function createSignedGoogleIdToken({
  audience,
  claims,
  keyId = "test-google-key",
}: {
  audience: string;
  claims: GoogleIdTokenClaims;
  keyId?: string;
}) {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  );
  const issuedAt = Math.floor(Date.now() / MS_PER_SECOND);
  const header = encodeBase64Url(JSON.stringify({ alg: "RS256", kid: keyId, typ: "JWT" }));
  const payload = encodeBase64Url(
    JSON.stringify({
      iss: "https://accounts.google.com",
      aud: audience,
      ...claims,
      iat: issuedAt,
      exp: issuedAt + GOOGLE_ID_TOKEN_LIFETIME_MS / MS_PER_SECOND,
    })
  );
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keyPair.privateKey,
    new TextEncoder().encode(signingInput)
  );
  const publicKey = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  return {
    token: `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`,
    publicKey: { ...publicKey, alg: "RS256", kid: keyId, use: "sig" },
  };
}

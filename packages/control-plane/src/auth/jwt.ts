/**
 * Mint HS256 JWTs using the Web Crypto API.
 *
 * Used for terminal auth: the control plane signs a JWT with the sandbox's
 * auth token, and the proxy inside the sandbox verifies it with the same key.
 */

function base64url(input: string | ArrayBuffer): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const str = btoa(binary);
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function mintJwt(payload: Record<string, unknown>, secret: string): Promise<string> {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const signingInput = `${header}.${body}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));

  return `${signingInput}.${base64url(signature)}`;
}

/** Whether a JWT has a numeric expiration strictly after `nowSeconds`. */
export function isJwtUnexpired(
  token: string | null,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): boolean {
  if (!token) return false;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const decoded = JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, "="))) as {
      exp?: unknown;
    };
    return typeof decoded.exp === "number" && decoded.exp > nowSeconds;
  } catch {
    return false;
  }
}

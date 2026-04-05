/**
 * Mint HS256 JWTs using the Web Crypto API.
 *
 * Used for terminal auth: the control plane signs a JWT with the sandbox's
 * auth token, and the proxy inside the sandbox verifies it with the same key.
 */

function base64url(input: string | ArrayBuffer): string {
  const str =
    typeof input === "string" ? btoa(input) : btoa(String.fromCharCode(...new Uint8Array(input)));
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

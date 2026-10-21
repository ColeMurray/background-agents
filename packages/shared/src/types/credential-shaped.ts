import type { z } from "zod";

/**
 * The keys whose values are credentials.
 *
 * A provider, a tool, or a page can answer with an object that carries a
 * token. Anything that crosses into the model context or the shared timeline
 * is checked against this list first, so a credential never becomes part of a
 * result a collaborator can read.
 */
export const CREDENTIAL_KEYS = new Set([
  "accesstoken",
  "refreshtoken",
  "authorization",
  "password",
  "secret",
  "clientsecret",
  "privatekey",
  "cookie",
]);

/**
 * Find every credential-shaped key anywhere in a value.
 *
 * The search is by key name at every depth, because a provider nests the
 * token inside its own answer.
 */
export function findCredentialLikeKeys(
  value: unknown,
  path: PropertyKey[] = [],
  found: Array<{ path: PropertyKey[]; key: string }> = []
): Array<{ path: PropertyKey[]; key: string }> {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => findCredentialLikeKeys(entry, [...path, index], found));
    return found;
  }
  if (typeof value !== "object" || value === null) return found;
  for (const [key, entry] of Object.entries(value)) {
    const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (CREDENTIAL_KEYS.has(normalized)) found.push({ path: [...path, key], key });
    findCredentialLikeKeys(entry, [...path, key], found);
  }
  return found;
}

/**
 * Refuse a value that carries a credential-shaped key.
 *
 * The guard is applied at the boundary, before the value is stored or
 * returned, so a credential cannot reach the model, the timeline, or the
 * audit.
 */
export function assertNoCredentialLikeKeys(
  value: unknown,
  context: z.RefinementCtx,
  path: PropertyKey[] = []
): void {
  for (const found of findCredentialLikeKeys(value, path)) {
    context.addIssue({
      code: "custom",
      path: found.path,
      message: "credential-like fields cannot cross the model boundary",
    });
  }
}

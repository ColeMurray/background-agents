import { error } from "./shared";

export type UnvalidatedSecrets = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Parse the common request envelope for every scoped-secret write endpoint.
 * Secret key/value validation remains owned by `prepareSecretsForWrite` in the
 * persistence layer so all callers use one canonical contract.
 */
export function parseSecretsRequestBody(body: unknown): UnvalidatedSecrets | Response {
  if (!isRecord(body) || !isRecord(body.secrets)) {
    return error("Request body must include secrets object", 400);
  }
  return body.secrets;
}

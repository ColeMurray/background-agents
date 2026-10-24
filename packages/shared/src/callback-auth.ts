import { isSignedCallbackPayload, verifyCallbackFromControlPlane } from "./auth";

export type CallbackAuthRejection =
  | { status: 500; error: "not configured"; reason: "secret_not_configured" }
  | { status: 401; error: "unauthorized"; reason: "invalid_signature" };

/**
 * Framework-neutral authentication for CP callbacks. Pass the original JSON object,
 * never schema output: normalization changes the signed bytes. Routes retain their
 * own parsing order, malformed-payload responses, logging, and framework adapters.
 */
export async function getCallbackAuthRejection(
  payload: unknown,
  env: { SERVICE_AUTH_SECRET?: string }
): Promise<CallbackAuthRejection | null> {
  if (!env.SERVICE_AUTH_SECRET) {
    return { status: 500, error: "not configured", reason: "secret_not_configured" };
  }
  if (!isSignedCallbackPayload(payload) || !(await verifyCallbackFromControlPlane(payload, env))) {
    return { status: 401, error: "unauthorized", reason: "invalid_signature" };
  }
  return null;
}

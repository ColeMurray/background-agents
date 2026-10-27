/**
 * Browser sign-in failure contract. The control plane redirects failed OAuth
 * callbacks to `SIGN_IN_FAILURE_PATH?error=<code>`; the web login page explains
 * the code. Better Auth's own callback codes (e.g. `state_mismatch`, or
 * `access_denied` when a user cancels consent) arrive the same way and are
 * deliberately not part of this list.
 */
export const SIGN_IN_FAILURE_PATH = "/login";

export const SIGN_IN_FAILURE_REASONS = [
  "admission_denied",
  "admission_unavailable",
  "github_email_permission_missing",
  "invalid_configuration",
  "invalid_request",
  "malformed_response",
  "provider_rejected",
  "provider_unavailable",
] as const;

export type SignInFailureReason = (typeof SIGN_IN_FAILURE_REASONS)[number];

export function isSignInFailureReason(value: string): value is SignInFailureReason {
  return SIGN_IN_FAILURE_REASONS.some((reason) => reason === value);
}

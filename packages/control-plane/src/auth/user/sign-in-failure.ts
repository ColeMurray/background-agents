import type { SignInProvider } from "@open-inspect/shared/sign-in-provider";
import { createLogger } from "../../logger";
import { AdmissionDeniedError, AdmissionUnavailableError } from "./admission-policy";
import { OAuthProviderError, type OAuthProviderFailure } from "./providers/types";

const logger = createLogger("auth:sign-in-failure");

/** Web page that explains a rejected sign-in; it renders outside the app shell. */
const SIGN_IN_FAILURE_PATH = "/login";

type SignInFailureReason = "access_denied" | "admission_unavailable" | OAuthProviderFailure;

function signInFailureReason(error: unknown): SignInFailureReason | null {
  if (error instanceof AdmissionDeniedError) return "access_denied";
  if (error instanceof AdmissionUnavailableError) return "admission_unavailable";
  if (error instanceof OAuthProviderError) return error.failure;
  return null;
}

/** Translate known failures only at the browser OAuth callback boundary. */
export function signInFailureLocation(provider: SignInProvider, error: unknown): string | null {
  const reason = signInFailureReason(error);
  if (!reason) return null;
  logger.warn("Sign-in rejected", {
    event: "auth.sign_in_rejected",
    provider,
    reason,
    diagnostic: error instanceof Error ? error.message : undefined,
  });
  const query = new URLSearchParams({ error: reason, provider });
  return `${SIGN_IN_FAILURE_PATH}?${query.toString()}`;
}

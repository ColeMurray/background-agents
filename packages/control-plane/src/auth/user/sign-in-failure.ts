import type { SignInProvider } from "@open-inspect/shared/sign-in-provider";
import { APIError } from "better-auth/api";
import { createLogger } from "../../logger";
import { AdmissionDeniedError, AdmissionUnavailableError } from "./admission-policy";
import type { ProviderProfileResolver } from "./provider-profile";
import { OAuthProviderError, type OAuthProviderFailure } from "./providers/types";

const logger = createLogger("auth:sign-in-failure");

/** Web page that explains a rejected sign-in; it renders outside the app shell. */
const SIGN_IN_FAILURE_PATH = "/access-denied";

type SignInFailureReason = "access_denied" | "admission_unavailable" | OAuthProviderFailure;

function signInFailureReason(error: unknown): SignInFailureReason | null {
  if (error instanceof AdmissionDeniedError) return "access_denied";
  if (error instanceof AdmissionUnavailableError) return "admission_unavailable";
  if (error instanceof OAuthProviderError) return error.failure;
  return null;
}

/**
 * Better Auth calls `getUserInfo` outside its own error handling, so an error
 * thrown there becomes an HTTP 500 on the OAuth callback. Known sign-in
 * failures redirect to the web's access-denied page instead, with a reason the
 * page can explain. Unexpected errors still propagate.
 */
export function redirectSignInFailures(
  provider: SignInProvider,
  resolver: ProviderProfileResolver
): ProviderProfileResolver {
  return async (tokens) => {
    try {
      return await resolver(tokens);
    } catch (error) {
      const reason = signInFailureReason(error);
      if (!reason) throw error;
      logger.warn("Sign-in rejected", {
        event: "auth.sign_in_rejected",
        provider,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
      const query = new URLSearchParams({ error: reason, provider });
      throw new APIError("FOUND", undefined, {
        Location: `${SIGN_IN_FAILURE_PATH}?${query.toString()}`,
      });
    }
  };
}

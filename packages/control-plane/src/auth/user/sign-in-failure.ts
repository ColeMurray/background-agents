import { createAuthMiddleware } from "better-auth/api";
import type { SignInFailureReason } from "@open-inspect/shared/sign-in-failure";
import { isSignInProvider, type SignInProvider } from "@open-inspect/shared/sign-in-provider";
import { createLogger } from "../../logger";
import { AdmissionDeniedError, AdmissionUnavailableError } from "./admission-policy";
import { GitHubEmailPermissionError } from "./providers/github-identity";
import { OAuthProviderError } from "./providers/types";

const logger = createLogger("auth:sign-in-failure");

export function signInFailureReason(error: unknown): SignInFailureReason | null {
  if (error instanceof AdmissionDeniedError) return "admission_denied";
  if (error instanceof AdmissionUnavailableError) return "admission_unavailable";
  if (error instanceof GitHubEmailPermissionError) return "github_email_permission_missing";
  if (error instanceof OAuthProviderError) return error.failure;
  return null;
}

/** Turn known sign-in failures into a redirect; anything else keeps propagating. */
export function withSignInFailureRedirect<Tokens, Profile>(
  provider: SignInProvider,
  getUserInfo: (tokens: Tokens) => Promise<Profile>,
  redirect: (reason: SignInFailureReason) => Error
): (tokens: Tokens) => Promise<Profile> {
  return async (tokens) => {
    try {
      return await getUserInfo(tokens);
    } catch (cause) {
      const reason = signInFailureReason(cause);
      if (!reason) throw cause;
      logger.warn("Sign-in rejected", {
        event: "auth.sign_in_rejected",
        provider,
        reason,
        diagnostic: cause instanceof Error ? cause.message : undefined,
      });
      throw redirect(reason);
    }
  };
}

/**
 * Wraps the provider resolver only inside the browser OAuth callback, sending
 * known failures to `errorURL` the way Better Auth reports its own callback
 * errors. Internal `accountInfo` calls share the resolver and must keep their
 * admission/integrity errors.
 *
 * Better Auth merges a before hook's `context` into the endpoint context with
 * arrays replaced (`defuReplaceArrays` in its dispatcher). That is what lets
 * the replacement `socialProviders` apply to this request only.
 */
export function createSignInFailureRedirectHook(errorURL: string) {
  return createAuthMiddleware(async (ctx) => {
    const providerId = ctx.params?.id;
    if (ctx.path !== "/callback/:id" || !providerId || !isSignInProvider(providerId)) return;
    return {
      context: {
        context: {
          socialProviders: ctx.context.socialProviders.map((provider) =>
            provider.id === providerId
              ? {
                  ...provider,
                  getUserInfo: withSignInFailureRedirect(
                    providerId,
                    provider.getUserInfo,
                    (reason) =>
                      ctx.redirect(`${errorURL}?${new URLSearchParams({ error: reason })}`)
                  ),
                }
              : provider
          ),
        },
      },
    };
  });
}

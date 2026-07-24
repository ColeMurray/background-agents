import { authorizeProviderIdentityRequest } from "../auth/identity-enforcement";
import type { Env } from "../types";
import { type RequestContext, type Route, error, json, parsePattern } from "./shared";

/** Providers that may be resolved through this authenticated route. */
const ALLOWED_PROVIDERS = ["github", "slack", "linear", "google"] as const;
type AllowedProvider = (typeof ALLOWED_PROVIDERS)[number];

function isAllowedProvider(value: string | undefined): value is AllowedProvider {
  return value !== undefined && (ALLOWED_PROVIDERS as readonly string[]).includes(value);
}

function pathSegment(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const decoded = decodeURIComponent(value).trim();
    return decoded.length > 0 ? decoded : undefined;
  } catch {
    return undefined;
  }
}

export async function handleResolveProviderIdentity(
  _request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const provider = match.groups?.provider;
  if (!isAllowedProvider(provider)) {
    return error(`provider must be one of: ${ALLOWED_PROVIDERS.join(", ")}`, 400);
  }

  const providerUserId = pathSegment(match.groups?.providerUserId);
  if (!providerUserId) {
    return error("providerUserId is required", 400);
  }

  const authz = authorizeProviderIdentityRequest(ctx, provider, providerUserId);
  if (authz.action === "deny") return authz.response;
  // The matching user token already fixes the canonical id. The request body
  // is deliberately ignored so this route cannot mutate identity linkage.
  return json({ userId: authz.canonicalUserId });
}

export const providerIdentityRoutes: Route[] = [
  {
    method: "PUT",
    pattern: parsePattern("/provider-identities/:provider/:providerUserId"),
    handler: handleResolveProviderIdentity,
  },
];

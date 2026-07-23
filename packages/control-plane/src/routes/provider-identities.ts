import { isCanonicalUserId } from "@open-inspect/shared";
import { enforceProviderIdentityPath } from "../auth/identity-enforcement";
import { UserStore, type ProviderIdentity } from "../db/user-store";
import type { Env } from "../types";
import {
  type RequestContext,
  type Route,
  error,
  json,
  parseJsonBody,
  parsePattern,
} from "./shared";

type UpsertProviderIdentityRequest = {
  providerLogin?: unknown;
  providerEmail?: unknown;
  displayName?: unknown;
  avatarUrl?: unknown;
};

/** Providers that may be upserted through this internal route. */
const ALLOWED_PROVIDERS = ["github", "slack", "linear", "google"] as const;
type AllowedProvider = (typeof ALLOWED_PROVIDERS)[number];

function isAllowedProvider(value: string | undefined): value is AllowedProvider {
  return value !== undefined && (ALLOWED_PROVIDERS as readonly string[]).includes(value);
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function pathSegment(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return optionalString(decodeURIComponent(value));
  } catch {
    return undefined;
  }
}

function isObjectRecord(value: unknown): value is UpsertProviderIdentityRequest {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function handleUpsertProviderIdentity(
  request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const body = await parseJsonBody<UpsertProviderIdentityRequest>(request);
  if (body instanceof Response) return body;
  if (!isObjectRecord(body)) {
    return error("Request body must be an object", 400);
  }

  const provider = match.groups?.provider;
  if (!isAllowedProvider(provider)) {
    return error(`provider must be one of: ${ALLOWED_PROVIDERS.join(", ")}`, 400);
  }

  const providerUserId = pathSegment(match.groups?.providerUserId);
  if (!providerUserId) {
    return error("providerUserId is required", 400);
  }
  const mismatch = enforceProviderIdentityPath(ctx, provider, providerUserId);
  if (mismatch) return mismatch;

  const identity: ProviderIdentity = {
    provider,
    providerUserId,
    providerLogin: optionalString(body.providerLogin),
    providerEmail: optionalString(body.providerEmail),
    displayName: optionalString(body.displayName),
    avatarUrl: optionalString(body.avatarUrl),
  };

  const resolvedUser = await new UserStore(ctx.db).resolveOrCreateUser(identity);
  if (!isCanonicalUserId(resolvedUser.id)) {
    return error("Resolved user ID is invalid", 500);
  }

  return json({ userId: resolvedUser.id });
}

export const providerIdentityRoutes: Route[] = [
  {
    method: "PUT",
    pattern: parsePattern("/provider-identities/:provider/:providerUserId"),
    handler: handleUpsertProviderIdentity,
  },
];

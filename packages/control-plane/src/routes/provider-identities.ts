import { isCanonicalUserId } from "@open-inspect/shared";
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

export async function handleUpsertProviderIdentity(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const body = await parseJsonBody<UpsertProviderIdentityRequest>(request);
  if (body instanceof Response) return body;

  const provider = pathSegment(match.groups?.provider);
  if (provider !== "github") {
    return error("provider must be github", 400);
  }

  const providerUserId = pathSegment(match.groups?.providerUserId);
  if (!providerUserId) {
    return error("providerUserId is required", 400);
  }

  const identity: ProviderIdentity = {
    provider: "github",
    providerUserId,
    providerLogin: optionalString(body.providerLogin),
    providerEmail: optionalString(body.providerEmail),
    displayName: optionalString(body.displayName),
    avatarUrl: optionalString(body.avatarUrl),
  };

  const resolvedUser = await new UserStore(env.DB).resolveOrCreateUser(identity);
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

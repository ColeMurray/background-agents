import { isCanonicalUserId } from "@open-inspect/shared";
import { UserStore, type ProviderIdentity } from "../db/user-store";
import type { Env } from "../types";
import { type RequestContext, type Route, error, json, parsePattern } from "./shared";

type UpsertProviderIdentityRequest = {
  providerLogin?: unknown;
  providerEmail?: unknown;
  displayName?: unknown;
  avatarUrl?: unknown;
};

type SupportedProvider = ProviderIdentity["provider"];

const SUPPORTED_PROVIDERS = new Set<SupportedProvider>(["github", "slack", "linear"]);

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

function isSupportedProvider(provider: string | undefined): provider is SupportedProvider {
  return provider != null && SUPPORTED_PROVIDERS.has(provider as SupportedProvider);
}

function isObjectBody(value: unknown): value is UpsertProviderIdentityRequest {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function parseUpsertProviderIdentityBody(
  request: Request
): Promise<UpsertProviderIdentityRequest | Response> {
  const raw = (await request.text()).trim();
  if (raw.length === 0) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return error("Invalid JSON body", 400);
  }

  if (!isObjectBody(parsed)) {
    return error("JSON body must be an object", 400);
  }

  return parsed;
}

export async function handleUpsertProviderIdentity(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const body = await parseUpsertProviderIdentityBody(request);
  if (body instanceof Response) return body;

  const provider = pathSegment(match.groups?.provider);
  if (!isSupportedProvider(provider)) {
    return error("provider must be one of: github, slack, linear", 400);
  }

  const providerUserId = pathSegment(match.groups?.providerUserId);
  if (!providerUserId) {
    return error("providerUserId is required", 400);
  }

  const identity: ProviderIdentity = {
    provider,
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

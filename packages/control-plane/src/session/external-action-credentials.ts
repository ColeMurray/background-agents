import type { JsonValue } from "@earendil-works/chord";
import type { ProviderFetch } from "./external-action-providers/executor";

/**
 * The credential source for external publications.
 *
 * A credential is minted for one call and closed over by the provider
 * executor. It never enters the action document, the model context, a result,
 * an error, or a log line. A provider with no credential is not registered at
 * all, so the agent never sees a publication it could not complete.
 */
export interface ExternalActionCredentialResolver {
  /**
   * Whether the deployment holds a credential for one provider.
   *
   * It is a cheap check — it never reaches a provider and never mints a
   * token — so it can be asked before an approval card is raised.
   */
  available(provider: string): Promise<boolean>;
  /**
   * The credential for one provider.
   *
   * Returns null when the deployment holds no usable credential for it, which
   * means the provider stays unregistered.
   */
  resolve(provider: string): Promise<{ headers: Record<string, string> } | null>;
}

/** The providers a deployment may publish through. */
export const EXTERNAL_ACTION_PROVIDERS = ["github", "gitlab", "slack", "linear"] as const;

export type ExternalActionProviderName = (typeof EXTERNAL_ACTION_PROVIDERS)[number];

/** The longest an external provider request may take. */
export const EXTERNAL_ACTION_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Parse the deployment's provider list.
 *
 * An unknown name is refused rather than ignored, so a typo never silently
 * narrows what a deployment may publish.
 */
export function parseExternalActionProviders(
  value: string | undefined
): ExternalActionProviderName[] {
  if (!value) return [];
  const names = value
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0);
  const allowed = new Set<string>(EXTERNAL_ACTION_PROVIDERS);
  const providers: ExternalActionProviderName[] = [];
  for (const name of names) {
    if (!allowed.has(name)) {
      throw new Error(`Unknown external action provider: ${name}`);
    }
    if (!providers.includes(name as ExternalActionProviderName)) {
      providers.push(name as ExternalActionProviderName);
    }
  }
  return providers;
}

/** The header a provider expects its credential in. */
export function providerAuthorizationHeader(
  provider: ExternalActionProviderName,
  token: string
): Record<string, string> {
  switch (provider) {
    case "linear":
      // Linear takes the API key itself in the Authorization header.
      return { authorization: token };
    case "github":
    case "gitlab":
    case "slack":
      return { authorization: `Bearer ${token}` };
  }
}

/**
 * The provider's own HTTP call.
 *
 * It is the platform's `fetch`, so the platform's egress rules apply, and it
 * never carries anything the caller did not put in the request.
 */
export const providerFetch: ProviderFetch = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body === undefined ? {} : { body: init.body }),
    signal: init.signal,
  });
  return response;
};

/** The action target fields a credential is scoped to, for the audit. */
export function credentialScopeDescription(target: Record<string, JsonValue>): string {
  const owner = target.owner;
  const repo = target.repo;
  const project = target.project;
  if (typeof owner === "string" && typeof repo === "string") return `${owner}/${repo}`;
  if (typeof project === "string") return project;
  if (typeof target.channel === "string") return `channel:${target.channel}`;
  if (typeof target.issueId === "string") return `issue:${target.issueId}`;
  return "unknown";
}

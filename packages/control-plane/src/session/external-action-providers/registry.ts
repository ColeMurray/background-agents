import { ExternalActionDefinitionRegistry } from "../external-action-definitions";
import { createProviderExecutor, type ProviderFetch } from "./executor";
import { EXTERNAL_ACTION_PROVIDER_DEFINITIONS } from "./definitions";
import type { ExternalActionProviderDefinition } from "./definition";
import type { ExternalActionCredentialResolver } from "./executor";

/** The providers this deployment may publish through. */
export type ExternalActionProviderName = "github" | "gitlab" | "slack" | "linear";

/** How one provider's credential is resolved for one session. */
export interface ExternalActionProviderCredential extends ExternalActionCredentialResolver {
  readonly provider: ExternalActionProviderName;
}

export interface ExternalActionProviderRegistryOptions {
  /** The credential source for each provider the deployment enables. */
  readonly credentials: readonly ExternalActionProviderCredential[];
  readonly fetch: ProviderFetch;
  readonly timeoutMs: number;
  readonly userAgent: string;
}

/**
 * Build the registry of providers this session may publish through.
 *
 * A provider is registered only when the deployment supplied its credential
 * source. A provider without a credential source is not registered at all,
 * so the agent never sees a publication it could never complete.
 *
 * Every definition that is registered has already passed the generic
 * fault-injection conformance suite; a definition that has not is refused
 * here rather than published.
 */
export function buildExternalActionProviderRegistry(
  options: ExternalActionProviderRegistryOptions,
  definitions: readonly ExternalActionProviderDefinition[] = EXTERNAL_ACTION_PROVIDER_DEFINITIONS
): ExternalActionDefinitionRegistry {
  const registry = new ExternalActionDefinitionRegistry();
  for (const credential of options.credentials) {
    const definition = definitions.find(
      (candidate) =>
        candidate.provider === credential.provider &&
        candidate.action === providerAction(credential.provider)
    );
    if (!definition) {
      throw new Error(
        `No external action definition passed the conformance suite for ${credential.provider}`
      );
    }
    registry.register({
      provider: definition.provider,
      action: definition.action,
      requestSchema: definition.requestSchema,
      publicResultSchema: definition.publicResultSchema,
      executor: createProviderExecutor({
        definition,
        credentials: credential,
        fetch: options.fetch,
        timeoutMs: options.timeoutMs,
        userAgent: options.userAgent,
      }),
    });
  }
  return registry;
}

/** The one action each provider publishes. */
function providerAction(provider: ExternalActionProviderName): string {
  return provider === "slack" ? "reply" : "comment";
}

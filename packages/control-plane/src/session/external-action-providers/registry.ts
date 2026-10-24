import { ExternalActionDefinitionRegistry } from "../external-action-definitions";
import type {
  ExternalActionCredentialResolver,
  ExternalActionProviderName,
} from "../external-action-credentials";
import { createProviderExecutor, type ProviderFetch } from "./executor";
import { EXTERNAL_ACTION_PROVIDER_DEFINITIONS } from "./definitions";
import type { ExternalActionProviderDefinition } from "./definition";

export interface ExternalActionProviderRegistryOptions {
  /** The credential source. The credential is resolved per call. */
  readonly credentials: ExternalActionCredentialResolver;
  readonly fetch: ProviderFetch;
  readonly timeoutMs: number;
  readonly userAgent: string;
  /** The providers this deployment named. */
  readonly enabledProviders: readonly ExternalActionProviderName[];
}

/**
 * Build the registry of providers this session may publish through.
 *
 * A provider is registered only when the deployment named it. The credential
 * itself is resolved per call, so it is never captured in a long-lived
 * closure, never outlives one request, and a credential that has expired is
 * refused rather than used. Every definition in the registry has passed the
 * generic fault-injection conformance suite.
 */
export function buildExternalActionProviderRegistry(
  options: ExternalActionProviderRegistryOptions
): ExternalActionDefinitionRegistry {
  const registry = new ExternalActionDefinitionRegistry();
  for (const provider of options.enabledProviders) {
    const definition = definitionFor(provider);
    if (!definition) {
      throw new Error(`No external action definition passed the conformance suite for ${provider}`);
    }
    registry.register({
      provider: definition.provider,
      action: definition.action,
      requestSchema: definition.requestSchema,
      publicResultSchema: definition.publicResultSchema,
      executor: createProviderExecutor({
        definition,
        credentials: {
          resolve: async () => options.credentials.resolve(provider),
        },
        fetch: options.fetch,
        timeoutMs: options.timeoutMs,
        userAgent: options.userAgent,
      }),
    });
  }
  return registry;
}

/** The definition for one provider, if it has one. */
function definitionFor(
  provider: ExternalActionProviderName
): ExternalActionProviderDefinition | undefined {
  return EXTERNAL_ACTION_PROVIDER_DEFINITIONS.find(
    (definition) => definition.provider === provider
  );
}

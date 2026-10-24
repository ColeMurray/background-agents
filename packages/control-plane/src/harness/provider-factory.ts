/**
 * Which provider serves a model.
 *
 * The harness asks for a provider by id; the deployment decides which
 * implementation answers. The seam holds those choices so that they are made
 * once — at open, before the first model call — and so that the provider the
 * harness wraps (the budget gate, for one) is the provider that actually runs
 * the model.
 *
 * The registry is vendor-neutral: the provider type is a parameter, so the seam
 * names no model SDK and no harness. The adapter owns the instance and
 * registers the deployment's own factories.
 */
export type HarnessProviderFactory<Provider> = () => Provider;

export interface HarnessProviderFactories<Provider> {
  /** Register the factory that serves a provider id. */
  register(providerId: string, factory: HarnessProviderFactory<Provider>): void;
  /** The factory that serves a provider id, if one is registered. */
  factoryFor(providerId: string): HarnessProviderFactory<Provider> | undefined;
  /** Forget a provider's factory. */
  forget(providerId: string): void;
}

/** A registry of provider factories. */
export function createHarnessProviderFactories<Provider>(): HarnessProviderFactories<Provider> {
  const factories = new Map<string, HarnessProviderFactory<Provider>>();
  return {
    register(providerId, factory) {
      factories.set(providerId, factory);
    },
    factoryFor(providerId) {
      return factories.get(providerId);
    },
    forget(providerId) {
      factories.delete(providerId);
    },
  };
}

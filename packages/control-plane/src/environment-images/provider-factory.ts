import { createSandboxProviderFromEnv } from "../sandbox/provider-factory";
import type { Env } from "../types";
import { ModalEnvironmentImageBuildAdapter } from "./modal-adapter";
import type { EnvironmentImageProvider } from "./model";
import type { AnyEnvironmentImageBuildAdapter } from "./types";

/**
 * Composition boundary for environment image provider adapters.
 *
 * Environment images run on the repo-image provider set (design §7.3); Modal
 * ships first, and the Vercel/OpenComputer adapters land with their
 * provider-session parity step.
 */
export interface EnvironmentImageBuildAdapterFactory {
  create(provider: EnvironmentImageProvider): AnyEnvironmentImageBuildAdapter;
}

export function createEnvironmentImageBuildAdapterFactory(
  env: Env
): EnvironmentImageBuildAdapterFactory {
  return new EnvEnvironmentImageBuildAdapterFactory(env);
}

class EnvEnvironmentImageBuildAdapterFactory implements EnvironmentImageBuildAdapterFactory {
  constructor(private readonly env: Env) {}

  create(provider: EnvironmentImageProvider): AnyEnvironmentImageBuildAdapter {
    switch (provider) {
      case "modal":
        return new ModalEnvironmentImageBuildAdapter(
          createSandboxProviderFromEnv(this.env, "modal")
        );
      case "vercel":
      case "opencomputer":
        throw new Error(`Environment image builds are not supported for provider: ${provider}`);
    }
  }
}

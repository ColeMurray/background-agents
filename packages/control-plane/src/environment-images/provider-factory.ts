import { createSandboxProviderFromEnv } from "../sandbox/provider-factory";
import type { Env } from "../types";
import { ModalEnvironmentImageBuildAdapter } from "./modal-adapter";
import type { EnvironmentImageProvider } from "./model";
import { OpenComputerEnvironmentImageBuildAdapter } from "./opencomputer-adapter";
import type {
  AnyEnvironmentImageBuildAdapter,
  EnvironmentImageBuildAdapter,
  ModalEnvironmentImageBuildPlan,
  OpenComputerEnvironmentImageBuildPlan,
  VercelEnvironmentImageBuildPlan,
} from "./types";
import { VercelEnvironmentImageBuildAdapter } from "./vercel-adapter";

/**
 * Composition boundary for environment image provider adapters.
 *
 * Environment images run on the repo-image provider set (design §7.3);
 * overloads preserve the provider→plan relationship so the workflow needs no
 * unsafe casts.
 */
export interface EnvironmentImageBuildAdapterFactory {
  create(provider: "modal"): EnvironmentImageBuildAdapter<ModalEnvironmentImageBuildPlan>;
  create(provider: "vercel"): EnvironmentImageBuildAdapter<VercelEnvironmentImageBuildPlan>;
  create(
    provider: "opencomputer"
  ): EnvironmentImageBuildAdapter<OpenComputerEnvironmentImageBuildPlan>;
  create(provider: EnvironmentImageProvider): AnyEnvironmentImageBuildAdapter;
}

export function createEnvironmentImageBuildAdapterFactory(
  env: Env
): EnvironmentImageBuildAdapterFactory {
  return new EnvEnvironmentImageBuildAdapterFactory(env);
}

class EnvEnvironmentImageBuildAdapterFactory implements EnvironmentImageBuildAdapterFactory {
  constructor(private readonly env: Env) {}

  create(provider: "modal"): EnvironmentImageBuildAdapter<ModalEnvironmentImageBuildPlan>;
  create(provider: "vercel"): EnvironmentImageBuildAdapter<VercelEnvironmentImageBuildPlan>;
  create(
    provider: "opencomputer"
  ): EnvironmentImageBuildAdapter<OpenComputerEnvironmentImageBuildPlan>;
  create(provider: EnvironmentImageProvider): AnyEnvironmentImageBuildAdapter {
    switch (provider) {
      case "modal":
        return new ModalEnvironmentImageBuildAdapter(
          createSandboxProviderFromEnv(this.env, "modal")
        );
      case "vercel":
        return new VercelEnvironmentImageBuildAdapter(
          createSandboxProviderFromEnv(this.env, "vercel")
        );
      case "opencomputer":
        return new OpenComputerEnvironmentImageBuildAdapter(
          createSandboxProviderFromEnv(this.env, "opencomputer")
        );
    }
  }
}

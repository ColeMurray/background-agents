import { createSandboxProviderFromEnv } from "../sandbox/provider-factory";
import type { Env } from "../types";
import { ModalRepoImageBuildAdapter } from "./modal-adapter";
import type { RepoImageProvider } from "./model";
import { OpenComputerRepoImageBuildAdapter } from "./opencomputer-adapter";
import { VercelRepoImageBuildAdapter } from "./vercel-adapter";
import type {
  AnyRepoImageBuildAdapter,
  ModalRepoImageBuildPlan,
  OpenComputerRepoImageBuildPlan,
  RepoImageBuildAdapter,
  VercelRepoImageBuildPlan,
} from "./types";

/**
 * Composition boundary for repo image provider adapters.
 *
 * Callers choose by provider name; overloads preserve the relationship between
 * provider and plan type so the workflow does not need unsafe casts or
 * provider-specific construction details.
 */
export interface RepoImageBuildAdapterFactory {
  create(provider: "modal"): RepoImageBuildAdapter<ModalRepoImageBuildPlan>;
  create(provider: "vercel"): RepoImageBuildAdapter<VercelRepoImageBuildPlan>;
  create(provider: "opencomputer"): RepoImageBuildAdapter<OpenComputerRepoImageBuildPlan>;
  create(provider: RepoImageProvider): AnyRepoImageBuildAdapter;
}

export function createRepoImageBuildAdapterFactory(env: Env): RepoImageBuildAdapterFactory {
  return new EnvRepoImageBuildAdapterFactory(env);
}

class EnvRepoImageBuildAdapterFactory implements RepoImageBuildAdapterFactory {
  constructor(private readonly env: Env) {}

  create(provider: "modal"): RepoImageBuildAdapter<ModalRepoImageBuildPlan>;
  create(provider: "vercel"): RepoImageBuildAdapter<VercelRepoImageBuildPlan>;
  create(provider: "opencomputer"): RepoImageBuildAdapter<OpenComputerRepoImageBuildPlan>;
  create(provider: RepoImageProvider): AnyRepoImageBuildAdapter {
    switch (provider) {
      case "modal":
        return new ModalRepoImageBuildAdapter(createSandboxProviderFromEnv(this.env, "modal"));
      case "vercel":
        return new VercelRepoImageBuildAdapter(createSandboxProviderFromEnv(this.env, "vercel"));
      case "opencomputer":
        return new OpenComputerRepoImageBuildAdapter(
          createSandboxProviderFromEnv(this.env, "opencomputer")
        );
    }
  }
}

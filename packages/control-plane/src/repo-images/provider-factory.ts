import { createSandboxProviderFromEnv } from "../sandbox/provider-factory";
import type { Env } from "../types";
import { ModalRepoImageBuildAdapter } from "./modal-adapter";
import { OpenComputerRepoImageBuildAdapter } from "./opencomputer-adapter";
import { VercelRepoImageBuildAdapter } from "./vercel-adapter";
import type {
  ModalRepoImageBuildPlan,
  OpenComputerRepoImageBuildPlan,
  RepoImageBuildAdapter,
  VercelRepoImageBuildPlan,
} from "./types";

export interface RepoImageBuildAdapterFactory {
  createModal(): RepoImageBuildAdapter<ModalRepoImageBuildPlan>;
  createVercel(): RepoImageBuildAdapter<VercelRepoImageBuildPlan>;
  createOpenComputer(): RepoImageBuildAdapter<OpenComputerRepoImageBuildPlan>;
}

export function createRepoImageBuildAdapterFactory(env: Env): RepoImageBuildAdapterFactory {
  return {
    createModal: () => new ModalRepoImageBuildAdapter(createSandboxProviderFromEnv(env, "modal")),
    createVercel: () =>
      new VercelRepoImageBuildAdapter(createSandboxProviderFromEnv(env, "vercel")),
    createOpenComputer: () =>
      new OpenComputerRepoImageBuildAdapter(createSandboxProviderFromEnv(env, "opencomputer")),
  };
}

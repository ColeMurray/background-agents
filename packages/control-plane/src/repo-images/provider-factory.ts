import { createSandboxProviderFromEnv } from "../sandbox/provider-factory";
import type { Env } from "../types";
import { getRepoImageBackend } from "./backend-policy";
import { ModalRepoImageBuildAdapter } from "./modal-adapter";
import { OpenComputerRepoImageBuildAdapter } from "./opencomputer-adapter";
import { VercelRepoImageBuildAdapter } from "./vercel-adapter";
import type { RepoImageBuildAdapter } from "./types";

export function createRepoImageBuildAdapter(env: Env): RepoImageBuildAdapter {
  const backend = getRepoImageBackend(env);
  switch (backend) {
    case "modal":
      return new ModalRepoImageBuildAdapter(createSandboxProviderFromEnv(env, "modal"));
    case "vercel":
      return new VercelRepoImageBuildAdapter(createSandboxProviderFromEnv(env, "vercel"));
    case "opencomputer":
      return new OpenComputerRepoImageBuildAdapter(
        createSandboxProviderFromEnv(env, "opencomputer")
      );
    default: {
      const unsupportedBackend: never = backend;
      throw new Error(`Repo image builds are not supported for provider ${unsupportedBackend}`);
    }
  }
}

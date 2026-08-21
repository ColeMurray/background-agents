import { createSandboxProviderFromEnv } from "../sandbox/provider-factory";
import type { Env } from "../types";
import { E2BImageBuildAdapter } from "./e2b-adapter";
import { ModalImageBuildAdapter } from "./modal-adapter";
import type { ImageBuildProvider } from "./model";
import { OpenComputerImageBuildAdapter } from "./opencomputer-adapter";
import type { ImageBuildAdapter } from "./types";
import { VercelImageBuildAdapter } from "./vercel-adapter";

/**
 * Composition boundary for image-build provider adapters.
 *
 * Providers share one lifecycle contract; only API translation varies.
 */
export interface ImageBuildAdapterFactory {
  /**
   * `start` validates configuration needed to create a provider session.
   * `existing_session` requires only the configuration needed to finalize or
   * clean up a session that has already been bound to the build.
   */
  create(provider: ImageBuildProvider, operation: "start" | "existing_session"): ImageBuildAdapter;
}

export function createImageBuildAdapterFactory(env: Env): ImageBuildAdapterFactory {
  return new EnvImageBuildAdapterFactory(env);
}

class EnvImageBuildAdapterFactory implements ImageBuildAdapterFactory {
  constructor(private readonly env: Env) {}

  create(provider: ImageBuildProvider, operation: "start" | "existing_session"): ImageBuildAdapter {
    switch (provider) {
      case "modal":
        return new ModalImageBuildAdapter(createSandboxProviderFromEnv(this.env, "modal"));
      case "vercel":
        return new VercelImageBuildAdapter(createSandboxProviderFromEnv(this.env, "vercel"));
      case "opencomputer":
        return new OpenComputerImageBuildAdapter(
          createSandboxProviderFromEnv(this.env, "opencomputer", {
            requireOpenComputerTemplate: operation === "start",
          })
        );
      case "e2b":
        return new E2BImageBuildAdapter(createSandboxProviderFromEnv(this.env, "e2b"));
    }
  }
}

import { createSandboxProviderFromEnv } from "../sandbox/provider-factory";
import type { Env } from "../types";
import { IsloImageBuildAdapter } from "./islo-adapter";
import { ModalImageBuildAdapter } from "./modal-adapter";
import type { ImageBuildProvider } from "./model";
import { OpenComputerImageBuildAdapter } from "./opencomputer-adapter";
import type {
  AnyImageBuildAdapter,
  ImageBuildAdapter,
  IsloImageBuildPlan,
  ModalImageBuildPlan,
  OpenComputerImageBuildPlan,
  VercelImageBuildPlan,
} from "./types";
import { VercelImageBuildAdapter } from "./vercel-adapter";

/**
 * Composition boundary for image-build provider adapters.
 *
 * Overloads preserve the provider→plan relationship so the workflow needs no
 * unsafe casts.
 */
export interface ImageBuildAdapterFactory {
  create(provider: "modal"): ImageBuildAdapter<ModalImageBuildPlan>;
  create(provider: "vercel"): ImageBuildAdapter<VercelImageBuildPlan>;
  create(provider: "opencomputer"): ImageBuildAdapter<OpenComputerImageBuildPlan>;
  create(provider: "islo"): ImageBuildAdapter<IsloImageBuildPlan>;
  create(provider: ImageBuildProvider): AnyImageBuildAdapter;
}

export function createImageBuildAdapterFactory(env: Env): ImageBuildAdapterFactory {
  return new EnvImageBuildAdapterFactory(env);
}

class EnvImageBuildAdapterFactory implements ImageBuildAdapterFactory {
  constructor(private readonly env: Env) {}

  create(provider: "modal"): ImageBuildAdapter<ModalImageBuildPlan>;
  create(provider: "vercel"): ImageBuildAdapter<VercelImageBuildPlan>;
  create(provider: "opencomputer"): ImageBuildAdapter<OpenComputerImageBuildPlan>;
  create(provider: "islo"): ImageBuildAdapter<IsloImageBuildPlan>;
  create(provider: ImageBuildProvider): AnyImageBuildAdapter {
    switch (provider) {
      case "modal":
        return new ModalImageBuildAdapter(createSandboxProviderFromEnv(this.env, "modal"));
      case "vercel":
        return new VercelImageBuildAdapter(createSandboxProviderFromEnv(this.env, "vercel"));
      case "opencomputer":
        return new OpenComputerImageBuildAdapter(
          createSandboxProviderFromEnv(this.env, "opencomputer")
        );
      case "islo":
        return new IsloImageBuildAdapter(createSandboxProviderFromEnv(this.env, "islo"));
    }
  }
}

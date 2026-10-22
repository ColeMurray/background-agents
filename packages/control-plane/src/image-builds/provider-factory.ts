import {
  createBoatRestClientFromEnv,
  createDaytonaRestClientFromEnv,
  createSandboxProviderFromEnv,
  resolveBoatDefaultMachineType,
} from "../sandbox/provider-factory";
import { resolveScmProviderFromEnv } from "../source-control";
import type { Env } from "../types";
import { BoatImageBuildAdapter } from "./boat-adapter";
import { BoatImageBuildResources } from "./boat-build-resources";
import { DaytonaImageBuildAdapter } from "./daytona-adapter";
import { DaytonaImageBuildResources } from "./daytona-build-resources";
import { E2BImageBuildAdapter } from "./e2b-adapter";
import { ModalImageBuildAdapter } from "./modal-adapter";
import type { ImageBuildProvider } from "./model";
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
      case "modal-vm":
        return new ModalImageBuildAdapter(createSandboxProviderFromEnv(this.env, provider));
      case "vercel":
        return new VercelImageBuildAdapter(createSandboxProviderFromEnv(this.env, "vercel"));
      case "e2b":
        return new E2BImageBuildAdapter(createSandboxProviderFromEnv(this.env, "e2b"));
      case "boat":
        if (operation === "start" && !this.env.BOAT_BASE_SNAPSHOT) {
          throw new Error("BOAT_BASE_SNAPSHOT is required to start a Boat image build");
        }
        return new BoatImageBuildAdapter(
          new BoatImageBuildResources(createBoatRestClientFromEnv(this.env), {
            scmProvider: resolveScmProviderFromEnv(this.env.SCM_PROVIDER),
            deploymentName: this.env.DEPLOYMENT_NAME,
            defaultMachineType: resolveBoatDefaultMachineType(this.env),
            baseSnapshot: this.env.BOAT_BASE_SNAPSHOT,
          })
        );
      case "daytona":
        return new DaytonaImageBuildAdapter(
          new DaytonaImageBuildResources(
            createDaytonaRestClientFromEnv(this.env, {
              requireBaseSnapshot: operation === "start",
            }),
            { scmProvider: resolveScmProviderFromEnv(this.env.SCM_PROVIDER) }
          )
        );
    }
  }
}

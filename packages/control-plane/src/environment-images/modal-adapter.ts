import type { ModalEnvironmentImageBuildProvider } from "../sandbox/providers/modal-provider";
import type {
  DeleteEnvironmentImageInput,
  EnvironmentImageBuildAdapter,
  EnvironmentImageBuildStartCallbacks,
  ModalEnvironmentImageBuildPlan,
} from "./types";

/**
 * Modal adapter for direct provider-image callbacks.
 *
 * Modal's environment image builder returns the final provider image id in
 * its callback, so no session binding or finalization step is needed here.
 */
export class ModalEnvironmentImageBuildAdapter implements EnvironmentImageBuildAdapter<ModalEnvironmentImageBuildPlan> {
  constructor(private readonly provider: ModalEnvironmentImageBuildProvider) {}

  async startBuild(
    plan: ModalEnvironmentImageBuildPlan,
    _callbacks: EnvironmentImageBuildStartCallbacks
  ): Promise<void> {
    await this.provider.triggerEnvironmentImageBuild({
      environmentId: plan.environmentId,
      buildId: plan.buildId,
      callbackUrl: plan.callbackUrl,
      repositories: plan.repositories,
      userEnvVars: plan.userEnvVars,
      buildTimeoutMs: plan.buildTimeoutMs,
      correlation: plan.correlation,
    });
  }

  async deleteImage(input: DeleteEnvironmentImageInput): Promise<void> {
    await this.provider.deleteProviderImage(input.image.providerImageId, input.correlation);
  }
}

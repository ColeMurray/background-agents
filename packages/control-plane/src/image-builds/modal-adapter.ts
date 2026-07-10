import type { ModalImageBuildProvider } from "../sandbox/providers/modal-provider";
import type {
  DeleteImageInput,
  ImageBuildAdapter,
  ImageBuildStartCallbacks,
  ModalImageBuildPlan,
} from "./types";

/**
 * Modal adapter for direct provider-image callbacks.
 *
 * Modal's data-plane builder returns the final provider image id in its
 * callback, so no session binding or finalization step is needed here.
 */
export class ModalImageBuildAdapter implements ImageBuildAdapter<ModalImageBuildPlan> {
  constructor(private readonly provider: ModalImageBuildProvider) {}

  async startBuild(plan: ModalImageBuildPlan, _callbacks: ImageBuildStartCallbacks): Promise<void> {
    await this.provider.triggerImageBuild({
      scopeKind: plan.scope.kind,
      scopeId: plan.scope.id,
      buildId: plan.buildId,
      callbackUrl: plan.callbackUrl,
      repositories: plan.repositories,
      userEnvVars: plan.userEnvVars,
      buildTimeoutMs: plan.buildTimeoutMs,
      correlation: plan.correlation,
    });
  }

  async deleteImage(input: DeleteImageInput): Promise<void> {
    await this.provider.deleteProviderImage(input.image.providerImageId, input.correlation);
  }
}

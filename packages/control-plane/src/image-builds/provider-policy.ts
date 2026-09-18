import { resolveSandboxBackendName, type SandboxBackendName } from "../sandbox/provider-name";
import type { Env } from "../types";
import {
  IMAGE_BUILD_PROVIDER_IDS,
  imageBuildProviderSchema,
  type ImageBuildProvider,
} from "./model";

/**
 * Central provider policy for image-build support.
 *
 * Keep capability and callback-mode decisions here so routes/workflows can work
 * from provider-neutral lifecycle terms instead of open-coded provider checks.
 */

export function getImageBuildsUnsupportedMessage(env: Env): string | null {
  if (resolveImageBuildProvider(env.SANDBOX_PROVIDER)) {
    return null;
  }

  return `Image builds are only available when SANDBOX_PROVIDER=${IMAGE_BUILD_PROVIDER_IDS.join(", ")}`;
}

export function resolveImageBuildProvider(value: string | undefined): ImageBuildProvider | null {
  const provider = resolveSandboxBackendName(value);
  return isImageBuildProvider(provider) ? provider : null;
}

function isImageBuildProvider(provider: SandboxBackendName): provider is ImageBuildProvider {
  return imageBuildProviderSchema.safeParse(provider).success;
}

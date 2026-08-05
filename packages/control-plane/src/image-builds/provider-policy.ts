import { resolveSandboxBackendName, type SandboxBackendName } from "../sandbox/provider-name";
import type { Env } from "../types";
import type { ImageBuildProvider } from "./model";

/**
 * Central provider policy for image-build support.
 *
 * Keep capability and callback-mode decisions here so routes/workflows can work
 * from provider-neutral lifecycle terms instead of open-coded provider checks.
 */

const IMAGE_BUILD_PROVIDERS = {
  modal: true,
  vercel: true,
  opencomputer: true,
} satisfies Record<ImageBuildProvider, true>;

export function getImageBuildsUnsupportedMessage(env: Env): string | null {
  if (resolveImageBuildProvider(env.SANDBOX_PROVIDER)) {
    return null;
  }

  return "Image builds are only available when SANDBOX_PROVIDER=modal, vercel, or opencomputer";
}

export function resolveImageBuildProvider(value: string | undefined): ImageBuildProvider | null {
  const provider = resolveSandboxBackendName(value);
  return isImageBuildProvider(provider) ? provider : null;
}

function isImageBuildProvider(provider: SandboxBackendName): provider is ImageBuildProvider {
  return provider in IMAGE_BUILD_PROVIDERS;
}

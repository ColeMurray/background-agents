import { resolveSandboxBackendName, type SandboxBackendName } from "../sandbox/provider-name";
import type { Env } from "../types";
import type { ImageBuildProvider } from "./model";

/**
 * Central provider policy for image-build support.
 *
 * Keep capability and callback-mode decisions here so routes/workflows can work
 * from provider-neutral lifecycle terms instead of open-coded provider checks.
 */

/** How the provider's build sandbox authenticates its git clones. */
export type ImageBuildCloneAuthMode = "credential_helper" | "none";

const IMAGE_BUILD_CLONE_AUTH_MODES = {
  modal: "credential_helper",
  vercel: "credential_helper",
  opencomputer: "credential_helper",
} satisfies Record<ImageBuildProvider, ImageBuildCloneAuthMode>;

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

export function getImageBuildProvider(env: Env): ImageBuildProvider {
  const provider = resolveImageBuildProvider(env.SANDBOX_PROVIDER);
  if (!provider) {
    throw new Error(`Image builds are not supported for SANDBOX_PROVIDER=${env.SANDBOX_PROVIDER}`);
  }
  return provider;
}

export function getImageBuildCloneAuthMode(provider: ImageBuildProvider): ImageBuildCloneAuthMode {
  return IMAGE_BUILD_CLONE_AUTH_MODES[provider];
}

function isImageBuildProvider(provider: SandboxBackendName): provider is ImageBuildProvider {
  return provider in IMAGE_BUILD_CLONE_AUTH_MODES;
}

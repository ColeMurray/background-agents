import { resolveSandboxBackendName, type SandboxBackendName } from "../sandbox/provider-name";
import type { Env } from "../types";
import type { ImageBuildProvider } from "./model";

/**
 * Central provider policy for image-build support.
 *
 * Keep capability and callback-mode decisions here so routes/workflows can work
 * from provider-neutral lifecycle terms instead of open-coded provider checks.
 */

/**
 * How a provider's build reports completion: provider_image callbacks carry
 * the finished artifact id (internal-HMAC auth); provider_session callbacks
 * come from the build sandbox itself (bearer token) and the control plane
 * snapshots the artifact afterwards.
 */
export type ImageBuildCallbackMode = "provider_image" | "provider_session";

/** How the provider's build sandbox authenticates its git clones. */
export type ImageBuildCloneAuthMode = "credential_helper" | "none";

const IMAGE_BUILD_CALLBACK_MODES = {
  modal: "provider_image",
  vercel: "provider_session",
  opencomputer: "provider_session",
} satisfies Record<ImageBuildProvider, ImageBuildCallbackMode>;

const IMAGE_BUILD_CLONE_AUTH_MODES = {
  modal: "none",
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

export function getImageBuildCallbackMode(provider: ImageBuildProvider): ImageBuildCallbackMode {
  return IMAGE_BUILD_CALLBACK_MODES[provider];
}

export function getImageBuildCloneAuthMode(provider: ImageBuildProvider): ImageBuildCloneAuthMode {
  return IMAGE_BUILD_CLONE_AUTH_MODES[provider];
}

function isImageBuildProvider(provider: SandboxBackendName): provider is ImageBuildProvider {
  return provider in IMAGE_BUILD_CALLBACK_MODES;
}

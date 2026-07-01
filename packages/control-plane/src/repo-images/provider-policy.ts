import { resolveSandboxBackendName, type SandboxBackendName } from "../sandbox/provider-name";
import type { Env } from "../types";
import type { RepoImageProvider } from "./model";
import type { RepoImageCallbackMode } from "./types";

/**
 * Central provider policy for repo image support.
 *
 * Keep capability and callback-mode decisions here so routes/workflows can work
 * from provider-neutral lifecycle terms instead of open-coded provider checks.
 */
const REPO_IMAGE_CALLBACK_MODES = {
  modal: "provider_image",
  vercel: "provider_session",
  opencomputer: "provider_session",
} satisfies Record<RepoImageProvider, RepoImageCallbackMode>;

export function getRepoImagesUnsupportedMessage(env: Env): string | null {
  if (resolveRepoImageProvider(env.SANDBOX_PROVIDER)) {
    return null;
  }

  return "Repo images are only available when SANDBOX_PROVIDER=modal, vercel, or opencomputer";
}

export function resolveRepoImageProvider(value: string | undefined): RepoImageProvider | null {
  const provider = resolveSandboxBackendName(value);
  return isRepoImageProvider(provider) ? provider : null;
}

export function getRepoImageProvider(env: Env): RepoImageProvider {
  const provider = resolveRepoImageProvider(env.SANDBOX_PROVIDER);
  if (!provider) {
    throw new Error(`Repo images are not supported for SANDBOX_PROVIDER=${env.SANDBOX_PROVIDER}`);
  }
  return provider;
}

export function getRepoImageCallbackMode(provider: RepoImageProvider): RepoImageCallbackMode {
  return REPO_IMAGE_CALLBACK_MODES[provider];
}

function isRepoImageProvider(provider: SandboxBackendName): provider is RepoImageProvider {
  return provider in REPO_IMAGE_CALLBACK_MODES;
}

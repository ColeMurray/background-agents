import type { RepoImageProvider } from "../db/repo-images";
import { resolveSandboxBackendName, type SandboxBackendName } from "../sandbox/provider-name";
import type { Env } from "../types";
import type { RepoImageCallbackMode } from "./types";

const REPO_IMAGE_CALLBACK_MODES = {
  modal: "provider_image",
  vercel: "provider_session",
  opencomputer: "provider_session",
} satisfies Record<RepoImageProvider, RepoImageCallbackMode>;

export function getRepoImagesUnsupportedMessage(env: Env): string | null {
  if (resolveRepoImageBackend(env.SANDBOX_PROVIDER)) {
    return null;
  }

  return "Repo images are only available when SANDBOX_PROVIDER=modal, vercel, or opencomputer";
}

export function resolveRepoImageBackend(value: string | undefined): RepoImageProvider | null {
  const backend = resolveSandboxBackendName(value);
  return isRepoImageBackend(backend) ? backend : null;
}

export function getRepoImageBackend(env: Env): RepoImageProvider {
  const backend = resolveRepoImageBackend(env.SANDBOX_PROVIDER);
  if (!backend) {
    throw new Error(`Repo images are not supported for SANDBOX_PROVIDER=${env.SANDBOX_PROVIDER}`);
  }
  return backend;
}

export function getRepoImageCallbackMode(backend: RepoImageProvider): RepoImageCallbackMode {
  return REPO_IMAGE_CALLBACK_MODES[backend];
}

function isRepoImageBackend(backend: SandboxBackendName): backend is RepoImageProvider {
  return backend in REPO_IMAGE_CALLBACK_MODES;
}

import type { RepoImageProvider } from "../db/repo-images";
import { resolveSandboxBackendName, supportsRepoImageBackend } from "../sandbox/provider-name";
import type { Env } from "../types";
import type { RepoImageCallbackMode } from "./types";

export function getRepoImagesUnsupportedMessage(env: Env): string | null {
  if (supportsRepoImageBackend(env.SANDBOX_PROVIDER)) {
    return null;
  }

  return "Repo images are only available when SANDBOX_PROVIDER=modal, vercel, or opencomputer";
}

export function resolveRepoImageBackend(value: string | undefined): RepoImageProvider | null {
  const backend = resolveSandboxBackendName(value);
  return backend === "modal" || backend === "vercel" || backend === "opencomputer" ? backend : null;
}

export function getRepoImageBackend(env: Env): RepoImageProvider {
  const backend = resolveRepoImageBackend(env.SANDBOX_PROVIDER);
  if (!backend) {
    throw new Error(`Repo images are not supported for SANDBOX_PROVIDER=${env.SANDBOX_PROVIDER}`);
  }
  return backend;
}

export function getRepoImageCallbackMode(backend: RepoImageProvider): RepoImageCallbackMode {
  return backend === "modal" ? "provider_image" : "provider_session";
}

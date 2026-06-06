/**
 * Public sandbox backend helpers for the web app.
 *
 * Backend parsing and capability lookups are delegated to @open-inspect/shared
 * so the web app and the control plane agree on a single source of truth.
 */

import {
  getProviderCapabilities,
  parseSandboxBackendName,
  type SandboxBackendName,
} from "@open-inspect/shared";

export type PublicSandboxProvider = SandboxBackendName;

function rawSandboxProvider(): string | undefined {
  return process.env.NEXT_PUBLIC_SANDBOX_PROVIDER ?? process.env.SANDBOX_PROVIDER;
}

export function getPublicSandboxProvider(): PublicSandboxProvider {
  return parseSandboxBackendName(rawSandboxProvider());
}

export function supportsRepoImages(): boolean {
  return getProviderCapabilities(rawSandboxProvider()).supportsPrebuiltImages === true;
}

export function supportsSandboxDocker(): boolean {
  return getProviderCapabilities(rawSandboxProvider()).supportsDocker === true;
}

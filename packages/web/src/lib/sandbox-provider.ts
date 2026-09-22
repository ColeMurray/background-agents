/**
 * Public sandbox backend helpers for the web app.
 */

import { IMAGE_BUILD_PROVIDER_IDS } from "@open-inspect/shared/types/image-builds";
import {
  isSandboxProviderName,
  supportsConfigurableSandboxResources as providerSupportsConfigurableSandboxResources,
  supportsConfigurableSandboxTimeout as providerSupportsConfigurableSandboxTimeout,
  type SandboxProviderName,
} from "@open-inspect/shared/types/integrations";

export type PublicSandboxProvider = SandboxProviderName;

/**
 * The single 501 body every image-build route answers with when the deployment's
 * provider has no image support. Derived from the list so adding a provider
 * cannot leave a stale message behind.
 */
export const REPO_IMAGES_UNSUPPORTED_MESSAGE = `Image builds are only available when SANDBOX_PROVIDER=${formatProviderList(IMAGE_BUILD_PROVIDER_IDS)}`;

export function getPublicSandboxProvider(): PublicSandboxProvider {
  const rawValue = process.env.NEXT_PUBLIC_SANDBOX_PROVIDER ?? process.env.SANDBOX_PROVIDER;
  if (!rawValue || rawValue.trim() === "") {
    return "modal";
  }

  const value = rawValue.trim().toLowerCase();
  if (isPublicSandboxProvider(value)) {
    return value;
  }

  throw new Error(`Invalid sandbox provider: ${rawValue}`);
}

export function supportsRepoImages(): boolean {
  return (IMAGE_BUILD_PROVIDER_IDS as readonly string[]).includes(getPublicSandboxProvider());
}

export function supportsConfigurableSandboxResources(): boolean {
  return providerSupportsConfigurableSandboxResources(getPublicSandboxProvider());
}

export function supportsConfigurableSandboxTimeout(): boolean {
  return providerSupportsConfigurableSandboxTimeout(getPublicSandboxProvider());
}

/** The providers named in the unsupported-provider copy, in display order. */
export function getRepoImageProviders(): readonly PublicSandboxProvider[] {
  return IMAGE_BUILD_PROVIDER_IDS;
}

function isPublicSandboxProvider(value: string): value is PublicSandboxProvider {
  return isSandboxProviderName(value);
}

/** "a, b, c, or d" — matches the control plane's wording for the same message. */
function formatProviderList(providers: readonly string[]): string {
  if (providers.length < 2) return providers.join("");
  return `${providers.slice(0, -1).join(", ")}, or ${providers[providers.length - 1]}`;
}

/**
 * Public sandbox backend helpers for the web app.
 */

/** Every backend the web app knows how to render. */
const SANDBOX_PROVIDERS = ["modal", "daytona", "vercel", "opencomputer", "e2b"] as const;

export type PublicSandboxProvider = (typeof SANDBOX_PROVIDERS)[number];

/**
 * Backends that can build and boot prebuilt repo/environment images. Mirrors
 * IMAGE_BUILD_PROVIDERS in the control plane's image-builds/provider-policy.ts —
 * a provider gains image-build support in both places or neither.
 */
const REPO_IMAGE_PROVIDERS = ["modal", "vercel", "opencomputer", "e2b"] as const;

/**
 * The single 501 body every image-build route answers with when the deployment's
 * provider has no image support. Derived from the list so adding a provider
 * cannot leave a stale message behind.
 */
export const REPO_IMAGES_UNSUPPORTED_MESSAGE = `Image builds are only available when SANDBOX_PROVIDER=${formatProviderList(REPO_IMAGE_PROVIDERS)}`;

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
  return (REPO_IMAGE_PROVIDERS as readonly string[]).includes(getPublicSandboxProvider());
}

/** The providers named in the unsupported-provider copy, in display order. */
export function getRepoImageProviders(): readonly PublicSandboxProvider[] {
  return REPO_IMAGE_PROVIDERS;
}

function isPublicSandboxProvider(value: string): value is PublicSandboxProvider {
  return (SANDBOX_PROVIDERS as readonly string[]).includes(value);
}

/** "a, b, c, or d" — matches the control plane's wording for the same message. */
function formatProviderList(providers: readonly string[]): string {
  if (providers.length < 2) return providers.join("");
  return `${providers.slice(0, -1).join(", ")}, or ${providers[providers.length - 1]}`;
}

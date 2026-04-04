/**
 * Public sandbox backend helpers for the web app.
 */

export type PublicSandboxProvider = "modal" | "daytona";

export function getPublicSandboxProvider(): PublicSandboxProvider {
  const rawValue = process.env.NEXT_PUBLIC_SANDBOX_PROVIDER ?? process.env.SANDBOX_PROVIDER;
  if (!rawValue || rawValue.trim() === "") {
    return "modal";
  }

  const value = rawValue.trim().toLowerCase();
  if (value === "modal" || value === "daytona") {
    return value;
  }

  throw new Error(`Invalid sandbox provider: ${rawValue}`);
}

export function supportsRepoImages(): boolean {
  return getPublicSandboxProvider() === "modal";
}

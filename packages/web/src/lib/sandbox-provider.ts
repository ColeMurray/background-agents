/**
 * Public sandbox backend helpers for the web app.
 */

export type PublicSandboxProvider = "modal" | "daytona";

export function getPublicSandboxProvider(): PublicSandboxProvider {
  const value = process.env.NEXT_PUBLIC_SANDBOX_PROVIDER ?? process.env.SANDBOX_PROVIDER ?? "modal";

  return value.trim().toLowerCase() === "daytona" ? "daytona" : "modal";
}

export function supportsRepoImages(): boolean {
  return getPublicSandboxProvider() === "modal";
}

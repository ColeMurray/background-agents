/** Browser sign-in providers with executable authentication adapters. */
export const SIGN_IN_PROVIDERS = ["github", "google"] as const;

export type SignInProvider = (typeof SIGN_IN_PROVIDERS)[number];

export function isSignInProvider(value: unknown): value is SignInProvider {
  return value === "github" || value === "google";
}

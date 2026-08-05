import { z } from "zod";

/** Sign-in providers with executable authentication adapters. */
export const SIGN_IN_PROVIDERS = ["github", "google"] as const;

export type SignInProvider = (typeof SIGN_IN_PROVIDERS)[number];

export const SIGN_IN_PROVIDER_ISSUERS = {
  github: "https://github.com",
  google: "https://accounts.google.com",
} as const satisfies Readonly<Record<SignInProvider, string>>;

export function isSignInProvider(provider: string): provider is SignInProvider {
  return SIGN_IN_PROVIDERS.some((candidate) => candidate === provider);
}

export function getSignInProviderIssuer(provider: string): string | null {
  if (isSignInProvider(provider)) {
    return SIGN_IN_PROVIDER_ISSUERS[provider];
  }
  return null;
}

export interface EnabledSignInProviders {
  readonly providers: readonly SignInProvider[];
}

const enabledSignInProvidersSchema = z
  .object({
    providers: z
      .array(z.enum(SIGN_IN_PROVIDERS))
      .min(1)
      .refine(
        (providers) =>
          providers.length === new Set(providers).size &&
          providers.every(
            (provider, index) =>
              SIGN_IN_PROVIDERS.filter((candidate) => providers.includes(candidate))[index] ===
              provider
          ),
        "Sign-in providers must be unique and in canonical order"
      ),
  })
  .strict();

export function parseEnabledSignInProviders(value: unknown): EnabledSignInProviders {
  return enabledSignInProvidersSchema.parse(value);
}

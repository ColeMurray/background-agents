"use client";

import type { SignInProvider } from "@open-inspect/shared";
import { useState } from "react";
import { signIn } from "@/lib/auth-session";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/error-banner";
import { GitHubIcon, GoogleIcon } from "@/components/ui/icons";

const PROVIDER_PRESENTATION = {
  github: {
    label: "GitHub",
    icon: GitHubIcon,
    variant: "primary",
  },
  google: {
    label: "Google",
    icon: GoogleIcon,
    variant: "outline",
  },
} as const satisfies Record<
  SignInProvider,
  {
    label: string;
    icon: typeof GitHubIcon;
    variant: "primary" | "outline";
  }
>;

export function SignInProviderButtons({ providers }: { providers: readonly SignInProvider[] }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSignIn(provider: SignInProvider) {
    setError(null);
    setPending(true);
    try {
      await signIn(provider);
    } catch {
      setError("Could not start sign in. Please try again.");
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-stretch gap-3" aria-busy={pending}>
      {error && <ErrorBanner role="alert">{error}</ErrorBanner>}
      {pending && (
        <p role="status" className="sr-only">
          Starting sign in
        </p>
      )}
      {providers.map((provider) => {
        const presentation = PROVIDER_PRESENTATION[provider];
        const Icon = presentation.icon;
        return (
          <Button
            key={provider}
            data-sign-in-provider={provider}
            type="button"
            variant={presentation.variant}
            className="gap-2 px-6 py-3"
            disabled={pending}
            onClick={() => void handleSignIn(provider)}
          >
            <Icon className="w-5 h-5" />
            Sign in with {presentation.label}
          </Button>
        );
      })}
    </div>
  );
}

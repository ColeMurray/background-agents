import Link from "next/link";
import { redirect } from "next/navigation";
import { SignInProviderButtons } from "@/components/sign-in-provider-buttons";
import { ErrorBanner } from "@/components/ui/error-banner";
import { AuthenticationUnavailableError } from "@/lib/authentication-unavailable-error";
import { getServerAuthSession, type ServerAuthSession } from "@/lib/server-auth-session";
import { getEnabledSignInProviders } from "@/lib/sign-in-providers";
import { APP_NAME } from "@/lib/site-config";

export const dynamic = "force-dynamic";

function LoginUnavailable() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-4 px-6">
      <ErrorBanner role="alert" className="max-w-md px-6 py-4 text-center">
        Sign-in is temporarily unavailable.
      </ErrorBanner>
      <Link href="/login" className="text-accent hover:underline">
        Try again
      </Link>
    </main>
  );
}

interface LoginPageProps {
  searchParams?: Promise<{ error?: string | string[]; provider?: string | string[] }>;
}

function signInErrorMessage(error: string | string[], provider?: string | string[]): string {
  if (error === "access_denied" || error === "AccessDenied") {
    return "Your account is not authorized to use this application.";
  }
  if (error === "provider_rejected" && provider === "github") {
    return "GitHub did not allow this application to read your verified email addresses. An administrator should check that the GitHub App has the Account permission 'Email addresses: Read-only'.";
  }
  if (error === "admission_unavailable" || error === "provider_unavailable") {
    return "Sign-in could not be completed right now. Please try again in a moment.";
  }
  return "An error occurred during sign in. Please try again.";
}

export default async function LoginPage({ searchParams }: LoginPageProps = {}) {
  let session: ServerAuthSession | null;
  try {
    session = await getServerAuthSession();
  } catch (error) {
    if (error instanceof AuthenticationUnavailableError) return <LoginUnavailable />;
    throw error;
  }
  if (session) redirect("/");

  let providers;
  try {
    providers = await getEnabledSignInProviders();
  } catch (error) {
    if (error instanceof AuthenticationUnavailableError) return <LoginUnavailable />;
    throw error;
  }

  const params = await searchParams;
  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-8 px-6">
      <div className="space-y-3 text-center">
        <h1 className="text-4xl font-bold text-foreground">Sign in to {APP_NAME}</h1>
        <p className="text-muted-foreground">Choose an authentication provider to continue.</p>
      </div>
      {params?.error && (
        <ErrorBanner role="alert" className="max-w-md px-6 py-4 text-center">
          {signInErrorMessage(params.error, params.provider)}
        </ErrorBanner>
      )}
      <SignInProviderButtons providers={providers} />
    </main>
  );
}

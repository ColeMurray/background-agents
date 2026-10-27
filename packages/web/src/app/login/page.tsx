import Link from "next/link";
import { redirect } from "next/navigation";
import {
  isSignInFailureReason,
  type SignInFailureReason,
} from "@open-inspect/shared/sign-in-failure";
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
  searchParams: Promise<{ error?: string | string[] }>;
}

const GENERIC_SIGN_IN_ERROR = "An error occurred during sign in. Please try again.";
const RETRYABLE_SIGN_IN_ERROR =
  "Sign-in could not be completed right now. Please try again in a moment.";

const SIGN_IN_FAILURE_MESSAGES: Readonly<Record<SignInFailureReason, string>> = {
  admission_denied: "Your account is not authorized to use this application.",
  admission_unavailable: RETRYABLE_SIGN_IN_ERROR,
  github_email_permission_missing:
    "GitHub did not allow this application to read your verified email addresses. An administrator should check that the GitHub App has the Account permission 'Email addresses: Read-only'.",
  invalid_configuration: GENERIC_SIGN_IN_ERROR,
  invalid_request: GENERIC_SIGN_IN_ERROR,
  malformed_response: GENERIC_SIGN_IN_ERROR,
  provider_rejected: GENERIC_SIGN_IN_ERROR,
  provider_unavailable: RETRYABLE_SIGN_IN_ERROR,
};

/** Better Auth's own callback codes and unknown values get the generic message. */
function signInErrorMessage(error: string): string {
  return isSignInFailureReason(error) ? SIGN_IN_FAILURE_MESSAGES[error] : GENERIC_SIGN_IN_ERROR;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
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

  const { error } = await searchParams;
  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-8 px-6">
      <div className="space-y-3 text-center">
        <h1 className="text-4xl font-bold text-foreground">Sign in to {APP_NAME}</h1>
        <p className="text-muted-foreground">Choose an authentication provider to continue.</p>
      </div>
      {typeof error === "string" && (
        <ErrorBanner role="alert" className="max-w-md px-6 py-4 text-center">
          {signInErrorMessage(error)}
        </ErrorBanner>
      )}
      <SignInProviderButtons providers={providers} />
    </main>
  );
}

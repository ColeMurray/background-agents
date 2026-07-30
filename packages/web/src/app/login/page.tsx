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

export default async function LoginPage() {
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

  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-8 px-6">
      <div className="space-y-3 text-center">
        <h1 className="text-4xl font-bold text-foreground">Sign in to {APP_NAME}</h1>
        <p className="text-muted-foreground">Choose an authentication provider to continue.</p>
      </div>
      <SignInProviderButtons providers={providers} />
    </main>
  );
}

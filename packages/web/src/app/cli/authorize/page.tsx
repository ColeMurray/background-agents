import Link from "next/link";
import { approveCliDeviceAuthorizationRequestSchema } from "@open-inspect/shared/types/cli-auth";
import { CliDeviceAuthorization } from "@/components/cli-device-authorization";
import { SignInProviderButtons } from "@/components/sign-in-provider-buttons";
import { ErrorBanner } from "@/components/ui/error-banner";
import { AuthenticationUnavailableError } from "@/lib/authentication-unavailable-error";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { getEnabledSignInProviders } from "@/lib/sign-in-providers";
import { APP_NAME } from "@/lib/site-config";

export const dynamic = "force-dynamic";

interface AuthorizePageProps {
  searchParams: Promise<{ user_code?: string | string[] }>;
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-background px-6 py-12 flex items-center justify-center">
      {children}
    </main>
  );
}

function Unavailable({ retryHref }: { retryHref: string }) {
  return (
    <PageShell>
      <div className="w-full max-w-lg space-y-4 text-center">
        <ErrorBanner role="alert">Authorization is temporarily unavailable.</ErrorBanner>
        <Link href={retryHref} className="text-accent hover:underline">
          Try again
        </Link>
      </div>
    </PageShell>
  );
}

export default async function AuthorizePage({ searchParams }: AuthorizePageProps) {
  const rawCode = (await searchParams).user_code;
  const parsed = approveCliDeviceAuthorizationRequestSchema.safeParse({
    userCode: typeof rawCode === "string" ? rawCode : "",
  });
  if (!parsed.success) {
    return (
      <PageShell>
        <ErrorBanner role="alert" className="w-full max-w-lg text-center">
          This authorization link is invalid. Return to your terminal and start sign-in again.
        </ErrorBanner>
      </PageShell>
    );
  }

  const { userCode } = parsed.data;
  const callbackURL = `/cli/authorize?user_code=${encodeURIComponent(userCode)}`;
  let session;
  try {
    session = await getServerAuthSession();
  } catch (error) {
    if (error instanceof AuthenticationUnavailableError)
      return <Unavailable retryHref={callbackURL} />;
    throw error;
  }

  if (session) {
    return (
      <PageShell>
        <CliDeviceAuthorization userCode={userCode} user={session.user} />
      </PageShell>
    );
  }

  let providers;
  try {
    providers = await getEnabledSignInProviders();
  } catch (error) {
    if (error instanceof AuthenticationUnavailableError)
      return <Unavailable retryHref={callbackURL} />;
    throw error;
  }

  return (
    <PageShell>
      <section className="w-full max-w-lg rounded-xl border border-border bg-card p-8 text-center shadow-sm">
        <p className="text-sm font-medium uppercase tracking-widest text-muted-foreground">
          Device authorization
        </p>
        <h1 className="mt-3 text-2xl font-semibold text-foreground">
          Sign in to authorize the CLI
        </h1>
        <p className="mt-3 text-muted-foreground">
          A CLI device requested access to this {APP_NAME} installation. Sign in before choosing
          whether to approve it.
        </p>
        <p
          aria-label="Authorization code"
          className="my-7 font-mono text-xl font-semibold tracking-wider"
        >
          {userCode}
        </p>
        <SignInProviderButtons providers={providers} callbackURL={callbackURL} />
      </section>
    </PageShell>
  );
}

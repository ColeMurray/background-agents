import { AppAuthBoundary } from "@/components/app-auth-boundary";
import { SidebarLayout } from "@/components/sidebar-layout";
import { redirect } from "next/navigation";
import { getServerAuthSession } from "@/lib/server-auth-session";
import { AuthenticationUnavailableError } from "@/lib/authentication-unavailable-error";
import { AuthSessionHydration } from "@/lib/auth-session";
import { ErrorBanner } from "@/components/ui/error-banner";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  let session;
  try {
    session = await getServerAuthSession();
  } catch (error) {
    if (error instanceof AuthenticationUnavailableError) {
      return (
        <div className="flex min-h-screen items-center justify-center px-6">
          <ErrorBanner role="alert">Authentication is temporarily unavailable.</ErrorBanner>
        </div>
      );
    }
    throw error;
  }
  if (!session) redirect("/login");

  return (
    <AuthSessionHydration session={session}>
      <AppAuthBoundary>
        <SidebarLayout>{children}</SidebarLayout>
      </AppAuthBoundary>
    </AuthSessionHydration>
  );
}

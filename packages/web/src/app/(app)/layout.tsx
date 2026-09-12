import { AppAuthBoundary } from "@/components/app-auth-boundary";
import { AuthenticatedModelPreferencesProvider } from "@/hooks/use-enabled-models";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppAuthBoundary>
      <AuthenticatedModelPreferencesProvider>{children}</AuthenticatedModelPreferencesProvider>
    </AppAuthBoundary>
  );
}

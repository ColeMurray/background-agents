import { AppAuthBoundary } from "@/components/app-auth-boundary";
import { ModelPreferencesProvider } from "@/hooks/use-enabled-models";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppAuthBoundary>
      <ModelPreferencesProvider>{children}</ModelPreferencesProvider>
    </AppAuthBoundary>
  );
}

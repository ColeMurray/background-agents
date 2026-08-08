import { AppAuthBoundary } from "@/components/app-auth-boundary";
import { SidebarLayout } from "@/components/sidebar-layout";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppAuthBoundary>
      <SidebarLayout>{children}</SidebarLayout>
    </AppAuthBoundary>
  );
}

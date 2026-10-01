import { SidebarLayout } from "@/components/sidebar-layout";
import { ActiveTeamProvider } from "@/hooks/use-active-team";

export default function SidebarAppLayout({ children }: { children: React.ReactNode }) {
  return (
    <ActiveTeamProvider>
      <SidebarLayout>{children}</SidebarLayout>
    </ActiveTeamProvider>
  );
}

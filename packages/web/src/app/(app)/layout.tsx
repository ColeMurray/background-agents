import { SidebarLayout } from "@/components/sidebar-layout";
import { getServerScmProvider } from "@/lib/scm-provider";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <SidebarLayout scmProvider={getServerScmProvider()}>{children}</SidebarLayout>;
}

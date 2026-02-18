import { SidebarLayout } from "@/components/sidebar-layout";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <SidebarLayout>{children}</SidebarLayout>;
}

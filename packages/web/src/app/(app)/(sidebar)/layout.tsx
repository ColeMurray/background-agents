import { SidebarLayout } from "@/components/sidebar-layout";

export default function SidebarAppLayout({ children }: { children: React.ReactNode }) {
  return <SidebarLayout>{children}</SidebarLayout>;
}

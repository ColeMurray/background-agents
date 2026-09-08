import { AppAuthBoundary } from "@/components/app-auth-boundary";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <AppAuthBoundary>{children}</AppAuthBoundary>;
}

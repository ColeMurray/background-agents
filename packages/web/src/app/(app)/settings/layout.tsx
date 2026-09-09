import { Suspense } from "react";
import { SettingsShell } from "@/components/settings/settings-shell";

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense fallback={null}>
      <SettingsShell>{children}</SettingsShell>
    </Suspense>
  );
}

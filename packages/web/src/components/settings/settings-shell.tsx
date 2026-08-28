"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useIsMobile } from "@/hooks/use-media-query";
import { supportsRepoImages } from "@/lib/sandbox-provider";
import { SettingsViewportProvider } from "@/components/settings/settings-viewport-context";
import {
  DEFAULT_SETTINGS_CATEGORY,
  isSettingsCategory,
  SettingsNav,
} from "@/components/settings/settings-nav";

export function SettingsShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const isMobile = useIsMobile();
  const [isHydrated, setIsHydrated] = useState(false);
  const tab = searchParams.get("tab");
  const activeCategory = pathname.startsWith("/settings/integrations/")
    ? "integrations"
    : isSettingsCategory(tab, supportsRepoImages())
      ? tab
      : DEFAULT_SETTINGS_CATEGORY;

  useEffect(() => setIsHydrated(true), []);

  if (!isHydrated) {
    return <main className="h-dvh overflow-hidden bg-background" aria-busy="true" />;
  }

  if (isMobile) {
    return (
      <SettingsViewportProvider value={true}>
        <main className="h-dvh overflow-hidden">{children}</main>
      </SettingsViewportProvider>
    );
  }

  return (
    <SettingsViewportProvider value={false}>
      <div className="flex h-dvh overflow-hidden bg-background">
        <SettingsNav
          activeCategory={activeCategory}
          onSelect={(category) => router.push(`/settings?tab=${category}`)}
        />
        <main className="min-w-0 flex-1 overflow-y-auto px-8 py-10 lg:px-12">
          <div className="mx-auto max-w-3xl">{children}</div>
        </main>
      </div>
    </SettingsViewportProvider>
  );
}

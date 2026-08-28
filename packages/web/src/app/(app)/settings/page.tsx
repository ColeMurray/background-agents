"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  getSettingsCategoryLabel,
  isSettingsCategory,
  SettingsNav,
  type SettingsCategory,
} from "@/components/settings/settings-nav";
import { SecretsSettings } from "@/components/settings/secrets-settings";
import { EnvironmentsSettings } from "@/components/settings/environments-settings";
import { ModelsSettings } from "@/components/settings/models-settings";
import { DataControlsSettings } from "@/components/settings/data-controls-settings";
import { KeyboardShortcutsSettings } from "@/components/settings/keyboard-shortcuts-settings";
import { IntegrationsSettings } from "@/components/settings/integrations-settings";
import { SandboxSettingsPage } from "@/components/settings/sandbox-settings";
import { ScmSettingsPage } from "@/components/settings/scm-settings";
import { ImagesSettings } from "@/components/settings/images-settings";
import { McpServersSettings } from "@/components/settings/mcp-servers-settings";
import { AppearanceSettings } from "@/components/settings/appearance-settings";
import { ProviderAccountsSettings } from "@/components/settings/provider-accounts-settings";
import { SkillsSettings } from "@/components/settings/skills-settings";
import { BackIcon, XIcon } from "@/components/ui/icons";
import { useIsMobile } from "@/hooks/use-media-query";
import { supportsRepoImages } from "@/lib/sandbox-provider";

function SettingsPageContent() {
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab");
  const repoImagesEnabled = supportsRepoImages();
  const initialCategory = isSettingsCategory(tabParam, repoImagesEnabled) ? tabParam : "secrets";
  const [activeCategory, setActiveCategoryRaw] = useState<SettingsCategory>(initialCategory);

  function setActiveCategory(category: SettingsCategory) {
    setActiveCategoryRaw(category);
    window.history.replaceState(null, "", `/settings?tab=${category}`);
  }
  const isMobile = useIsMobile();
  const [mobileView, setMobileView] = useState<"list" | "detail">(
    isSettingsCategory(tabParam, repoImagesEnabled) ? "detail" : "list"
  );
  const mobileHeadingRef = useRef<HTMLHeadingElement>(null);

  function showMobileView(view: "list" | "detail") {
    setMobileView(view);
    requestAnimationFrame(() => mobileHeadingRef.current?.focus());
  }

  function showMobileList() {
    window.history.replaceState(null, "", "/settings");
    showMobileView("list");
  }

  // Sync state when searchParams change via client-side navigation
  useEffect(() => {
    if (isSettingsCategory(tabParam, repoImagesEnabled)) {
      setActiveCategoryRaw(tabParam);
      setMobileView("detail");
      return;
    }

    setActiveCategoryRaw("secrets");
    setMobileView("list");
  }, [repoImagesEnabled, tabParam]);

  const content = (
    <>
      {activeCategory === "secrets" && <SecretsSettings />}
      {activeCategory === "environments" && <EnvironmentsSettings />}
      {activeCategory === "models" && <ModelsSettings />}
      {activeCategory === "provider-accounts" && <ProviderAccountsSettings />}
      {activeCategory === "images" && repoImagesEnabled && <ImagesSettings />}
      {activeCategory === "appearance" && <AppearanceSettings />}
      {activeCategory === "keyboard-shortcuts" && <KeyboardShortcutsSettings />}
      {activeCategory === "data-controls" && <DataControlsSettings />}
      {activeCategory === "sandbox" && <SandboxSettingsPage />}
      {activeCategory === "scm" && <ScmSettingsPage />}
      {activeCategory === "integrations" && <IntegrationsSettings />}
      {activeCategory === "skills" && <SkillsSettings />}
      {activeCategory === "mcp-servers" && <McpServersSettings />}
    </>
  );

  if (isMobile) {
    return (
      <div className="flex h-full flex-col bg-background">
        {mobileView === "list" ? (
          <>
            <header className="grid h-14 shrink-0 grid-cols-[2.5rem_1fr_2.5rem] items-center border-b border-border-muted px-3">
              <span aria-hidden="true" />
              <h1
                ref={mobileHeadingRef}
                tabIndex={-1}
                className="text-center text-sm font-medium text-foreground outline-none"
              >
                Settings
              </h1>
              <Link
                href="/"
                className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground"
                aria-label="Close settings"
              >
                <XIcon className="h-4 w-4" />
              </Link>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <SettingsNav
                activeCategory={activeCategory}
                onSelect={setActiveCategory}
                onNavigate={() => showMobileView("detail")}
              />
            </div>
          </>
        ) : (
          <>
            <header className="grid h-14 shrink-0 grid-cols-[2.5rem_1fr_2.5rem] items-center border-b border-border-muted px-3">
              <button
                type="button"
                onClick={showMobileList}
                className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground"
                aria-label="Back to settings"
              >
                <BackIcon className="h-4 w-4" />
              </button>
              <h1
                ref={mobileHeadingRef}
                tabIndex={-1}
                className="truncate px-2 text-center text-sm font-medium text-foreground outline-none"
              >
                {getSettingsCategoryLabel(activeCategory)}
              </h1>
              <Link
                href="/"
                className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground"
                aria-label="Close settings"
              >
                <XIcon className="h-4 w-4" />
              </Link>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
              <div className="mx-auto max-w-3xl">{content}</div>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full overflow-hidden bg-background">
      <SettingsNav activeCategory={activeCategory} onSelect={setActiveCategory} />
      <div className="min-w-0 flex-1 overflow-y-auto px-8 py-10 lg:px-12">
        <div className="mx-auto max-w-3xl">{content}</div>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Suspense fallback={null}>
      <SettingsPageContent />
    </Suspense>
  );
}

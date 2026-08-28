"use client";

import { Suspense, useEffect, useRef, useState, type ComponentType } from "react";
import { useSearchParams } from "next/navigation";
import {
  DEFAULT_SETTINGS_CATEGORY,
  getSettingsCategoryLabel,
  isSettingsCategory,
  SettingsNav,
  type SettingsCategory,
} from "@/components/settings/settings-nav";
import { SettingsMobileHeader } from "@/components/settings/settings-mobile-header";
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
import { useIsMobile } from "@/hooks/use-media-query";
import { supportsRepoImages } from "@/lib/sandbox-provider";

const SETTINGS_PANELS: Record<SettingsCategory, ComponentType> = {
  appearance: AppearanceSettings,
  "keyboard-shortcuts": KeyboardShortcutsSettings,
  models: ModelsSettings,
  "provider-accounts": ProviderAccountsSettings,
  skills: SkillsSettings,
  environments: EnvironmentsSettings,
  secrets: SecretsSettings,
  scm: ScmSettingsPage,
  sandbox: SandboxSettingsPage,
  images: ImagesSettings,
  integrations: IntegrationsSettings,
  "mcp-servers": McpServersSettings,
  "data-controls": DataControlsSettings,
};

function SettingsPageContent() {
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab");
  const repoImagesEnabled = supportsRepoImages();
  const isMobile = useIsMobile();
  const initialCategory = isSettingsCategory(tabParam, repoImagesEnabled)
    ? tabParam
    : DEFAULT_SETTINGS_CATEGORY;
  const [activeCategory, setActiveCategoryRaw] = useState<SettingsCategory>(initialCategory);

  function setActiveCategory(category: SettingsCategory) {
    setActiveCategoryRaw(category);
    const url = `/settings?tab=${category}`;
    if (isMobile) {
      window.history.pushState(
        { ...window.history.state, openInspectSettingsDetail: true },
        "",
        url
      );
    } else {
      window.history.replaceState(window.history.state, "", url);
    }
  }
  const [mobileView, setMobileView] = useState<"list" | "detail">(
    isSettingsCategory(tabParam, repoImagesEnabled) ? "detail" : "list"
  );
  const mobileHeadingRef = useRef<HTMLHeadingElement>(null);

  function showMobileView(view: "list" | "detail") {
    setMobileView(view);
    requestAnimationFrame(() => mobileHeadingRef.current?.focus());
  }

  function showMobileList() {
    if (window.history.state?.openInspectSettingsDetail) {
      window.history.back();
      return;
    }
    window.history.replaceState(window.history.state, "", "/settings");
    showMobileView("list");
  }

  useEffect(() => {
    if (!isMobile) return;

    const syncFromHistory = () => {
      const category = new URLSearchParams(window.location.search).get("tab");
      if (isSettingsCategory(category, repoImagesEnabled)) {
        setActiveCategoryRaw(category);
        setMobileView("detail");
      } else {
        setActiveCategoryRaw(DEFAULT_SETTINGS_CATEGORY);
        setMobileView("list");
      }
      requestAnimationFrame(() => mobileHeadingRef.current?.focus());
    };

    window.addEventListener("popstate", syncFromHistory);
    return () => window.removeEventListener("popstate", syncFromHistory);
  }, [isMobile, repoImagesEnabled]);

  // Sync state when searchParams change via client-side navigation
  useEffect(() => {
    if (isSettingsCategory(tabParam, repoImagesEnabled)) {
      setActiveCategoryRaw(tabParam);
      setMobileView("detail");
      return;
    }

    setActiveCategoryRaw(DEFAULT_SETTINGS_CATEGORY);
    setMobileView("list");
  }, [repoImagesEnabled, tabParam]);

  const renderedCategory = isSettingsCategory(activeCategory, repoImagesEnabled)
    ? activeCategory
    : DEFAULT_SETTINGS_CATEGORY;
  const ActivePanel = SETTINGS_PANELS[renderedCategory];
  const content = <ActivePanel />;

  if (isMobile) {
    return (
      <div className="flex h-full flex-col bg-background">
        {mobileView === "list" ? (
          <>
            <SettingsMobileHeader title="Settings" headingRef={mobileHeadingRef} />
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
            <SettingsMobileHeader
              title={getSettingsCategoryLabel(activeCategory)}
              headingRef={mobileHeadingRef}
              onBack={showMobileList}
            />
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
              <div className="mx-auto max-w-3xl">{content}</div>
            </div>
          </>
        )}
      </div>
    );
  }

  return content;
}

export default function SettingsPage() {
  return (
    <Suspense fallback={null}>
      <SettingsPageContent />
    </Suspense>
  );
}

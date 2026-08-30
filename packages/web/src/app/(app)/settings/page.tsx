"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  DEFAULT_SETTINGS_CATEGORY,
  getSettingsCategoryLabel,
  isSettingsCategory,
  SettingsNav,
  type SettingsCategory,
} from "@/components/settings/settings-nav";
import { SettingsMobileHeader } from "@/components/settings/settings-mobile-header";
import { useSettingsIsMobile } from "@/components/settings/settings-viewport-context";
import { supportsRepoImages } from "@/lib/sandbox-provider";
import { useCurrentUserAuthorization } from "@/hooks/use-current-user-authorization";
import { getSettingsPanel, resolveSettingsCategory } from "@/components/settings/settings-registry";
import type { PermissionId } from "@open-inspect/shared/rbac";

function resolveAuthorizedCategory(
  requested: string | null,
  repoImagesEnabled: boolean,
  permissions: readonly PermissionId[] | undefined
) {
  return resolveSettingsCategory(
    requested,
    repoImagesEnabled,
    (permission) => permissions?.includes(permission) ?? false
  );
}

function SettingsPageContent() {
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab");
  const repoImagesEnabled = supportsRepoImages();
  const isMobile = useSettingsIsMobile();
  const { authorization, loading } = useCurrentUserAuthorization();
  const permissions = authorization?.permissions;
  const initialCategory = resolveAuthorizedCategory(tabParam, repoImagesEnabled, permissions);
  const [activeCategory, setActiveCategoryRaw] = useState<SettingsCategory>(initialCategory);

  function selectCategory(category: SettingsCategory, trigger: HTMLButtonElement) {
    setActiveCategoryRaw(category);
    const url = `/settings?tab=${category}`;
    if (isMobile) {
      mobileTriggerRef.current = trigger;
      window.history.pushState(
        { ...window.history.state, openInspectSettingsDetail: true },
        "",
        url
      );
      showMobileView("detail");
    } else {
      window.history.replaceState(window.history.state, "", url);
    }
  }
  const [mobileView, setMobileView] = useState<"list" | "detail">(
    isSettingsCategory(tabParam, repoImagesEnabled) ? "detail" : "list"
  );
  const mobileListHeadingRef = useRef<HTMLHeadingElement>(null);
  const mobileDetailHeadingRef = useRef<HTMLHeadingElement>(null);
  const mobileTriggerRef = useRef<HTMLButtonElement>(null);

  function showMobileView(view: "list" | "detail") {
    setMobileView(view);
    requestAnimationFrame(() => {
      if (view === "list" && mobileTriggerRef.current) {
        mobileTriggerRef.current.focus();
      } else {
        (view === "list" ? mobileListHeadingRef : mobileDetailHeadingRef).current?.focus();
      }
    });
  }

  function showMobileList() {
    if (window.history.state?.openInspectSettingsDetail) {
      window.history.back();
      return;
    }
    window.history.replaceState(window.history.state, "", "/settings");
    setActiveCategoryRaw(DEFAULT_SETTINGS_CATEGORY);
    showMobileView("list");
  }

  useEffect(() => {
    if (!isMobile) return;

    const syncFromHistory = () => {
      const requestedCategory = new URLSearchParams(window.location.search).get("tab");
      const nextCategory = isSettingsCategory(requestedCategory, repoImagesEnabled)
        ? resolveAuthorizedCategory(requestedCategory, repoImagesEnabled, permissions)
        : null;
      if (nextCategory) {
        setActiveCategoryRaw(nextCategory);
        setMobileView("detail");
      } else {
        if (!mobileTriggerRef.current) setActiveCategoryRaw(DEFAULT_SETTINGS_CATEGORY);
        setMobileView("list");
      }
      requestAnimationFrame(() => {
        if (!nextCategory && mobileTriggerRef.current) {
          mobileTriggerRef.current.focus();
        } else {
          (nextCategory ? mobileDetailHeadingRef : mobileListHeadingRef).current?.focus();
        }
      });
    };

    window.addEventListener("popstate", syncFromHistory);
    return () => window.removeEventListener("popstate", syncFromHistory);
  }, [isMobile, permissions, repoImagesEnabled]);

  // Sync state when searchParams change via client-side navigation
  useEffect(() => {
    if (isSettingsCategory(tabParam, repoImagesEnabled)) {
      setActiveCategoryRaw(resolveAuthorizedCategory(tabParam, repoImagesEnabled, permissions));
      setMobileView("detail");
      return;
    }

    if (!isMobile || !mobileTriggerRef.current) {
      setActiveCategoryRaw(resolveAuthorizedCategory(null, repoImagesEnabled, permissions));
    }
    setMobileView("list");
  }, [isMobile, permissions, repoImagesEnabled, tabParam]);

  if (loading) return null;
  const renderedCategory = resolveAuthorizedCategory(
    activeCategory,
    repoImagesEnabled,
    permissions
  );
  const ActivePanel = getSettingsPanel(renderedCategory);
  const content = (
    <Suspense fallback={null}>
      <ActivePanel />
    </Suspense>
  );

  if (isMobile) {
    return (
      <div className="h-full bg-background">
        <div
          hidden={mobileView !== "list"}
          className={mobileView === "list" ? "flex h-full flex-col" : "hidden"}
        >
          <SettingsMobileHeader title="Settings" headingRef={mobileListHeadingRef} />
          <div className="min-h-0 flex-1 overflow-y-auto">
            <SettingsNav activeCategory={activeCategory} onSelect={selectCategory} />
          </div>
        </div>
        <div
          hidden={mobileView !== "detail"}
          className={mobileView === "detail" ? "flex h-full flex-col" : "hidden"}
        >
          <SettingsMobileHeader
            title={getSettingsCategoryLabel(activeCategory)}
            headingRef={mobileDetailHeadingRef}
            onBack={showMobileList}
          />
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
            <div className="mx-auto max-w-3xl">{mobileView === "detail" ? content : null}</div>
          </div>
        </div>
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

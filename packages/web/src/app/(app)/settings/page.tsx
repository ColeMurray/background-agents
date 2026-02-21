"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useSidebarContext } from "@/components/sidebar-layout";
import { SettingsNav, type SettingsCategory } from "@/components/settings/settings-nav";
import { SecretsSettings } from "@/components/settings/secrets-settings";
import { ModelsSettings } from "@/components/settings/models-settings";
import { DataControlsSettings } from "@/components/settings/data-controls-settings";
import { KeyboardShortcutsSettings } from "@/components/settings/keyboard-shortcuts-settings";
import { IntegrationsSettings } from "@/components/settings/integrations-settings";
import { SHORTCUT_LABELS } from "@/lib/keyboard-shortcuts";
import { SidebarIcon, BackIcon } from "@/components/ui/icons";
import { useIsMobile } from "@/hooks/use-media-query";

const CATEGORY_LABELS: Record<SettingsCategory, string> = {
  secrets: "Secrets",
  models: "Models",
  "keyboard-shortcuts": "Keyboard",
  "data-controls": "Data Controls",
  integrations: "Integrations",
};

const VALID_CATEGORIES = new Set<string>([
  "secrets",
  "models",
  "keyboard-shortcuts",
  "data-controls",
  "integrations",
]);

function isValidCategory(tab: string | null): tab is SettingsCategory {
  return tab !== null && VALID_CATEGORIES.has(tab);
}

export default function SettingsPage() {
  const { isOpen, toggle } = useSidebarContext();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab");
  const initialCategory = isValidCategory(tabParam) ? tabParam : "secrets";
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>(initialCategory);
  const isMobile = useIsMobile();
  const [mobileView, setMobileView] = useState<"list" | "detail">(
    isValidCategory(tabParam) ? "detail" : "list"
  );

  // Sync state when searchParams change via client-side navigation
  useEffect(() => {
    if (isValidCategory(tabParam)) {
      setActiveCategory(tabParam);
      setMobileView("detail");
    }
  }, [tabParam]);

  const content = (
    <>
      {activeCategory === "secrets" && <SecretsSettings />}
      {activeCategory === "models" && <ModelsSettings />}
      {activeCategory === "keyboard-shortcuts" && <KeyboardShortcutsSettings />}
      {activeCategory === "data-controls" && <DataControlsSettings />}
      {activeCategory === "integrations" && <IntegrationsSettings />}
    </>
  );

  if (isMobile) {
    return (
      <div className="h-full flex flex-col">
        {mobileView === "list" ? (
          <>
            <header className="border-b border-border-muted flex-shrink-0">
              <div className="px-4 py-3">
                <button
                  onClick={toggle}
                  className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition"
                  title={`Open sidebar (${SHORTCUT_LABELS.TOGGLE_SIDEBAR})`}
                  aria-label={`Open sidebar (${SHORTCUT_LABELS.TOGGLE_SIDEBAR})`}
                >
                  <SidebarIcon className="w-4 h-4" />
                </button>
              </div>
            </header>
            <div className="flex-1 overflow-y-auto">
              <SettingsNav
                activeCategory={activeCategory}
                onSelect={setActiveCategory}
                onNavigate={() => setMobileView("detail")}
              />
            </div>
          </>
        ) : (
          <>
            <header className="border-b border-border-muted flex-shrink-0">
              <div className="px-4 py-3 flex items-center gap-2">
                <button
                  onClick={toggle}
                  className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition"
                  title={`Open sidebar (${SHORTCUT_LABELS.TOGGLE_SIDEBAR})`}
                  aria-label={`Open sidebar (${SHORTCUT_LABELS.TOGGLE_SIDEBAR})`}
                >
                  <SidebarIcon className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setMobileView("list")}
                  className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition"
                  aria-label="Back to settings"
                >
                  <BackIcon className="w-4 h-4" />
                </button>
                <h2 className="text-sm font-medium text-foreground">
                  {CATEGORY_LABELS[activeCategory]}
                </h2>
              </div>
            </header>
            <div className="flex-1 overflow-y-auto p-4">
              <div className="max-w-2xl">{content}</div>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {!isOpen && (
        <header className="border-b border-border-muted flex-shrink-0">
          <div className="px-4 py-3">
            <button
              onClick={toggle}
              className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition"
              title={`Open sidebar (${SHORTCUT_LABELS.TOGGLE_SIDEBAR})`}
              aria-label={`Open sidebar (${SHORTCUT_LABELS.TOGGLE_SIDEBAR})`}
            >
              <SidebarIcon className="w-4 h-4" />
            </button>
          </div>
        </header>
      )}

      <div className="flex-1 flex overflow-hidden">
        <SettingsNav activeCategory={activeCategory} onSelect={setActiveCategory} />
        <div className="flex-1 overflow-y-auto p-8">
          <div className="max-w-2xl">{content}</div>
        </div>
      </div>
    </div>
  );
}

"use client";

import { useState } from "react";
import { useSidebarContext } from "@/components/sidebar-layout";
import { SettingsNav, type SettingsCategory } from "@/components/settings/settings-nav";
import { SecretsSettings } from "@/components/settings/secrets-settings";
import { ModelsSettings } from "@/components/settings/models-settings";
import { DataControlsSettings } from "@/components/settings/data-controls-settings";
import { KeyboardShortcutsSettings } from "@/components/settings/keyboard-shortcuts-settings";
import { IntegrationsSettings } from "@/components/settings/integrations-settings";
import { SHORTCUT_LABELS } from "@/lib/keyboard-shortcuts";
import { SidebarToggleIcon } from "@/components/sidebar-toggle-icon";
import { useIsMobile } from "@/hooks/use-media-query";

const CATEGORY_LABELS: Record<SettingsCategory, string> = {
  secrets: "Secrets",
  models: "Models",
  "keyboard-shortcuts": "Keyboard",
  "data-controls": "Data Controls",
  integrations: "Integrations",
};

export default function SettingsPage() {
  const { isOpen, toggle } = useSidebarContext();
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>("secrets");
  const isMobile = useIsMobile();
  const [mobileView, setMobileView] = useState<"list" | "detail">("list");

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
                  <SidebarToggleIcon />
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
                  <SidebarToggleIcon />
                </button>
                <button
                  onClick={() => setMobileView("list")}
                  className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition"
                  aria-label="Back to settings"
                >
                  <BackIcon />
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
              <SidebarToggleIcon />
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

function BackIcon() {
  return (
    <svg
      className="w-4 h-4"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

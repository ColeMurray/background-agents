"use client";

import { useState } from "react";
import { useSidebarContext } from "@/components/sidebar-layout";
import { SettingsNav, type SettingsCategory } from "@/components/settings/settings-nav";
import { SecretsSettings } from "@/components/settings/secrets-settings";
import { ModelsSettings } from "@/components/settings/models-settings";
import { DataControlsSettings } from "@/components/settings/data-controls-settings";
import { KeyboardShortcutsSettings } from "@/components/settings/keyboard-shortcuts-settings";
import { SHORTCUT_LABELS } from "@/lib/keyboard-shortcuts";
import { SidebarToggleIcon } from "@/components/sidebar-toggle-icon";

export default function SettingsPage() {
  const { isOpen, toggle } = useSidebarContext();
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>("secrets");

  return (
    <div className="h-full flex flex-col">
      {/* Header with toggle when sidebar is closed */}
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
          <div className="max-w-2xl">
            {activeCategory === "secrets" && <SecretsSettings />}
            {activeCategory === "models" && <ModelsSettings />}
            {activeCategory === "keyboard-shortcuts" && <KeyboardShortcutsSettings />}
            {activeCategory === "data-controls" && <DataControlsSettings />}
          </div>
        </div>
      </div>
    </div>
  );
}

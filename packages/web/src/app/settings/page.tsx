"use client";

import { useState } from "react";
import { SidebarLayout, useSidebarContext } from "@/components/sidebar-layout";
import { SettingsNav, type SettingsCategory } from "@/components/settings/settings-nav";
import { SecretsSettings } from "@/components/settings/secrets-settings";
import { DataControlsSettings } from "@/components/settings/data-controls-settings";

export default function SettingsPage() {
  return (
    <SidebarLayout>
      <SettingsContent />
    </SidebarLayout>
  );
}

function SettingsContent() {
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
              title="Open sidebar"
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
            {activeCategory === "data-controls" && <DataControlsSettings />}
          </div>
        </div>
      </div>
    </div>
  );
}

function SidebarToggleIcon() {
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
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
    </svg>
  );
}

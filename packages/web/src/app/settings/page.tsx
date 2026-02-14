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
      {/* header - matches DashboardPageLayout pattern */}
      <header className="flex items-center justify-between w-full sticky top-0 z-20 backdrop-blur-md h-20 px-6 lg:px-12 xl:px-20 bg-clay-100/90 flex-shrink-0">
        <div className="flex items-center gap-3">
          {!isOpen && (
            <button
              onClick={toggle}
              className="flex items-center justify-center size-10 rounded-full transition-colors hover:bg-ash-100"
              title="Open sidebar"
            >
              <SidebarToggleIcon />
            </button>
          )}
          <h1 className="text-2xl sm:text-3xl font-semibold text-ash-900 font-clash">Settings</h1>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        <SettingsNav activeCategory={activeCategory} onSelect={setActiveCategory} />
        <div className="flex-1 overflow-y-auto py-6 lg:pb-12 pt-8 px-4 lg:px-12 xl:px-20">
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

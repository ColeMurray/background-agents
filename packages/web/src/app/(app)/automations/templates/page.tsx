"use client";

import Link from "next/link";
import { CollapsedSidebarControls, useSidebarContext } from "@/components/sidebar-layout";
import { TemplateGallery } from "@/components/automations/template-gallery";
import { BackIcon } from "@/components/ui/icons";

export default function AutomationTemplatesPage() {
  const { isOpen } = useSidebarContext();

  return (
    <div className="h-full flex flex-col">
      {!isOpen && (
        <header className="border-b border-border-muted flex-shrink-0">
          <div className="px-4 py-3 flex items-center gap-2">
            <CollapsedSidebarControls />
            <Link
              href="/automations"
              className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition"
              aria-label="Back to automations"
            >
              <BackIcon className="w-4 h-4" />
            </Link>
          </div>
        </header>
      )}

      <div className="flex-1 overflow-y-auto p-8">
        <div className="max-w-3xl mx-auto">
          <div className="mb-6">
            <h1 className="text-3xl font-semibold text-foreground">Automation templates</h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Start from a pre-built idea instead of a blank form. Pick a template, choose a
              repository, and create.
            </p>
          </div>

          <TemplateGallery />
        </div>
      </div>
    </div>
  );
}

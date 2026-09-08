"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { CollapsedSidebarControls, useSidebarContext } from "@/components/sidebar-layout";
import { TemplateGallery } from "@/components/automations/template-gallery";
import { BackIcon } from "@/components/ui/icons";
import { useCurrentUserAuthorization } from "@/hooks/use-current-user-authorization";

export default function AutomationTemplatesPage() {
  const { isOpen } = useSidebarContext();
  const router = useRouter();
  const { hasPermission, loading } = useCurrentUserAuthorization();
  const canCreate = hasPermission("automations.create");

  useEffect(() => {
    if (!loading && !canCreate) router.replace("/automations");
  }, [canCreate, loading, router]);

  if (loading || !canCreate) return null;

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

      <div className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
        <div className="max-w-3xl mx-auto">
          <div className="mb-6">
            <h1 className="text-2xl font-semibold text-foreground sm:text-3xl">
              Automation templates
            </h1>
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

"use client";

import { useState } from "react";
import Link from "next/link";
import { CollapsedSidebarControls, useSidebarContext } from "@/components/sidebar-layout";
import { useAutomations } from "@/hooks/use-automations";
import { AutomationsList } from "@/components/automations/automations-list";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/error-banner";
import { PlusIcon } from "@/components/ui/icons";

export default function AutomationsPage() {
  const { isOpen } = useSidebarContext();
  const { automations, loading, mutate } = useAutomations();

  const [actionError, setActionError] = useState<string | null>(null);

  const handleAction = async (id: string, action: "pause" | "resume" | "trigger" | "delete") => {
    setActionError(null);
    const endpoint =
      action === "delete" ? `/api/automations/${id}` : `/api/automations/${id}/${action}`;
    const method = action === "delete" ? "DELETE" : "POST";

    try {
      const res = await fetch(endpoint, { method });
      if (!res.ok) {
        setActionError(`Failed to ${action} automation`);
        return;
      }
      mutate();
    } catch (error) {
      console.error(`Failed to ${action} automation:`, error);
      setActionError(`Failed to ${action} automation`);
    }
  };

  return (
    <div className="h-full flex flex-col">
      {!isOpen && (
        <header className="border-b border-border-muted flex-shrink-0">
          <div className="px-4 py-3">
            <CollapsedSidebarControls />
          </div>
        </header>
      )}

      <div className="flex-1 overflow-y-auto p-8">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center justify-between mb-6">
            <h1 className="text-3xl font-semibold text-foreground">Automations</h1>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" asChild>
                <Link href="/automations/templates">Browse templates</Link>
              </Button>
              <Button size="sm" asChild>
                <Link href="/automations/new" className="flex items-center gap-1.5">
                  <PlusIcon className="w-4 h-4" />
                  Create Automation
                </Link>
              </Button>
            </div>
          </div>

          {actionError && (
            <ErrorBanner className="mb-4" role="alert">
              {actionError}
            </ErrorBanner>
          )}

          {loading ? (
            <div className="flex justify-center py-12">
              <div className="animate-spin rounded-full h-6 w-6 border-2 border-current border-t-transparent text-muted-foreground" />
            </div>
          ) : (
            <AutomationsList
              automations={automations}
              onPause={(id) => handleAction(id, "pause")}
              onResume={(id) => handleAction(id, "resume")}
              onTrigger={(id) => handleAction(id, "trigger")}
              onDelete={(id) => handleAction(id, "delete")}
            />
          )}
        </div>
      </div>
    </div>
  );
}

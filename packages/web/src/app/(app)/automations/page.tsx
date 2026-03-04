"use client";

import { useState } from "react";
import Link from "next/link";
import { useSidebarContext } from "@/components/sidebar-layout";
import { useAutomations } from "@/hooks/use-automations";
import { AutomationsList } from "@/components/automations/automations-list";
import { Button } from "@/components/ui/button";
import { SidebarIcon, PlusIcon } from "@/components/ui/icons";
import { SHORTCUT_LABELS } from "@/lib/keyboard-shortcuts";

export default function AutomationsPage() {
  const { isOpen, toggle } = useSidebarContext();
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

      <div className="flex-1 overflow-y-auto p-8">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center justify-between mb-6">
            <h1 className="text-2xl font-semibold text-foreground">Automations</h1>
            <Link href="/automations/new">
              <Button size="sm">
                <span className="flex items-center gap-1.5">
                  <PlusIcon className="w-4 h-4" />
                  Create Automation
                </span>
              </Button>
            </Link>
          </div>

          {actionError && (
            <div
              role="alert"
              className="mb-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md px-4 py-3 text-sm text-red-700 dark:text-red-400"
            >
              {actionError}
            </div>
          )}

          {loading ? (
            <div className="flex justify-center py-12">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-muted-foreground" />
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

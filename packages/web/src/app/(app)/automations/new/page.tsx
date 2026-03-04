"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSidebarContext } from "@/components/sidebar-layout";
import {
  AutomationForm,
  type AutomationFormValues,
} from "@/components/automations/automation-form";
import { SidebarIcon, BackIcon } from "@/components/ui/icons";
import { SHORTCUT_LABELS } from "@/lib/keyboard-shortcuts";
import Link from "next/link";

export default function NewAutomationPage() {
  const { isOpen, toggle } = useSidebarContext();
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (values: AutomationFormValues) => {
    setSubmitting(true);
    setError("");

    try {
      const res = await fetch("/api/automations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });

      if (res.ok) {
        const data = await res.json();
        router.push(`/automations/${data.automation.id}`);
      } else {
        const data = await res.json();
        setError(data.error || "Failed to create automation");
        setSubmitting(false);
      }
    } catch {
      setError("Failed to create automation");
      setSubmitting(false);
    }
  };

  return (
    <div className="h-full flex flex-col">
      {!isOpen && (
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
        <div className="max-w-2xl mx-auto">
          <h1 className="text-2xl font-semibold text-foreground mb-6">Create Automation</h1>

          {error && (
            <div
              role="alert"
              className="mb-4 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 px-4 py-3 border border-red-200 dark:border-red-800 text-sm"
            >
              {error}
            </div>
          )}

          <AutomationForm mode="create" onSubmit={handleSubmit} submitting={submitting} />
        </div>
      </div>
    </div>
  );
}

"use client";

import { useState, use } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useSidebarContext } from "@/components/sidebar-layout";
import { useAutomation } from "@/hooks/use-automations";
import {
  AutomationForm,
  type AutomationFormValues,
} from "@/components/automations/automation-form";
import { ErrorBanner } from "@/components/ui/error-banner";
import { SidebarIcon, BackIcon } from "@/components/ui/icons";
import { SHORTCUT_LABELS } from "@/lib/keyboard-shortcuts";

export default function EditAutomationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { isOpen, toggle } = useSidebarContext();
  const router = useRouter();
  const { automation, loading } = useAutomation(id);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (values: AutomationFormValues) => {
    setSubmitting(true);
    setError("");

    try {
      const res = await fetch(`/api/automations/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });

      if (res.ok) {
        router.push(`/automations/${id}`);
      } else {
        const data = await res.json();
        setError(data.error || "Failed to update automation");
        setSubmitting(false);
      }
    } catch {
      setError("Failed to update automation");
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-muted-foreground" />
      </div>
    );
  }

  if (!automation) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4">
        <p className="text-muted-foreground">Automation not found.</p>
        <Link href="/automations">
          <button className="text-sm text-accent hover:underline">Back to Automations</button>
        </Link>
      </div>
    );
  }

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
              href={`/automations/${id}`}
              className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition"
              aria-label="Back to automation"
            >
              <BackIcon className="w-4 h-4" />
            </Link>
          </div>
        </header>
      )}

      <div className="flex-1 overflow-y-auto p-8">
        <div className="max-w-2xl mx-auto">
          <h1 className="text-2xl font-semibold text-foreground mb-6">Edit Automation</h1>

          {error && (
            <ErrorBanner className="mb-4" role="alert">
              {error}
            </ErrorBanner>
          )}

          <AutomationForm
            mode="edit"
            initialValues={{
              name: automation.name,
              repoOwner: automation.repoOwner,
              repoName: automation.repoName,
              baseBranch: automation.baseBranch,
              model: automation.model,
              reasoningEffort: automation.reasoningEffort,
              scheduleCron: automation.scheduleCron ?? "0 9 * * *",
              scheduleTz: automation.scheduleTz,
              instructions: automation.instructions,
              triggerType: automation.triggerType,
              eventType: automation.eventType ?? undefined,
              triggerConfig: automation.triggerConfig ?? undefined,
            }}
            onSubmit={handleSubmit}
            submitting={submitting}
          />
        </div>
      </div>
    </div>
  );
}

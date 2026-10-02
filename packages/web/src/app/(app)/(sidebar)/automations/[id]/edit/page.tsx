"use client";

import { useEffect, useState, use } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { CollapsedSidebarControls, useSidebarContext } from "@/components/sidebar-layout";
import { useAutomation } from "@/hooks/use-automations";
import {
  AutomationForm,
  type AutomationFormValues,
} from "@/components/automations/automation-form";
import { ErrorBanner } from "@/components/ui/error-banner";
import { BackIcon } from "@/components/ui/icons";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { useSWRConfig } from "swr";
import { invalidateAutomationCache } from "@/lib/automation-cache";
import { automationNavigation, automationScopeTeamId } from "@/lib/automation-navigation";
import { sameEnvironmentIds } from "@/components/automations/automation-target-selection";

export default function EditAutomationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { isOpen } = useSidebarContext();
  const router = useRouter();
  const teamId = automationScopeTeamId(useSearchParams().get("teamId"));
  const navigation = automationNavigation(teamId);
  const { automation, loading } = useAutomation(id);
  const swr = useSWRConfig();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const canManage = automation?.capabilities?.canManage === true;

  useEffect(() => {
    if (!loading && automation && !canManage) {
      router.replace(automationNavigation(teamId).detail(id));
    }
  }, [automation, canManage, id, loading, router, teamId]);

  const handleSubmit = async (values: AutomationFormValues) => {
    if (!canManage || !automation) return;
    setSubmitting(true);
    setError("");

    try {
      const { environmentIds, ...otherValues } = values;
      const res = await browserApiFetch(`/api/automations/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          sameEnvironmentIds(environmentIds, automation.environmentIds) ? otherValues : values
        ),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to update automation");
      }
      await invalidateAutomationCache(swr, id);
      router.push(navigation.detail(id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to update automation");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="animate-spin rounded-full h-6 w-6 border-2 border-current border-t-transparent text-muted-foreground" />
      </div>
    );
  }

  if (!automation) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4">
        <p className="text-muted-foreground">Automation not found.</p>
        <Link href={navigation.list}>
          <button type="button" className="text-sm text-accent hover:underline">
            Back to Automations
          </button>
        </Link>
      </div>
    );
  }

  if (!canManage) return null;

  return (
    <div className="h-full flex flex-col">
      {!isOpen && (
        <header className="border-b border-border-muted flex-shrink-0">
          <div className="px-4 py-3 flex items-center gap-2">
            <CollapsedSidebarControls />
            <Link
              href={navigation.detail(id)}
              className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition"
              aria-label="Back to automation"
            >
              <BackIcon className="w-4 h-4" />
            </Link>
          </div>
        </header>
      )}

      <div className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
        <div className="max-w-2xl mx-auto">
          <h1 className="mb-6 text-2xl font-semibold text-foreground sm:text-3xl">
            Edit Automation
          </h1>

          {error && (
            <ErrorBanner className="mb-4" role="alert">
              {error}
            </ErrorBanner>
          )}

          <AutomationForm
            mode="edit"
            initialValues={{
              teamId: automation.ownerTeamId ?? null,
              name: automation.name,
              repositories: automation.repositories,
              environmentIds: automation.environmentIds,
              harness: automation.harness,
              model: automation.model,
              reasoningEffort: automation.reasoningEffort,
              scheduleCron: automation.scheduleCron ?? "0 9 * * *",
              scheduleTz: automation.scheduleTz,
              instructions: automation.instructions,
              triggerType: automation.triggerType,
              eventType: automation.eventType ?? undefined,
              triggerConfig: automation.triggerConfig ?? undefined,
              providerSelections: automation.providerSelections,
            }}
            onSubmit={handleSubmit}
            submitting={submitting}
          />
        </div>
      </div>
    </div>
  );
}

"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CollapsedSidebarControls, useSidebarContext } from "@/components/sidebar-layout";
import {
  AutomationForm,
  type AutomationFormValues,
} from "@/components/automations/automation-form";
import { useAutomationDuplicate } from "@/components/automations/use-automation-duplicate";
import { AutomationFormSkeleton } from "@/components/automations/automation-form-skeleton";
import { WebhookConfig } from "@/components/automations/webhook-config";
import { automationTemplates } from "@/lib/automation-templates";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/error-banner";
import { BackIcon } from "@/components/ui/icons";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import Link from "next/link";
import { useSWRConfig } from "swr";
import { invalidateAutomationCache } from "@/lib/automation-cache";
import { useAutomationScope } from "@/hooks/use-automation-scope";
import { useCanCreateAutomation } from "@/hooks/use-can-create-automation";

function PrefillNotice({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-4 rounded-md border border-border-muted bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function NewAutomationContent() {
  const { isOpen } = useSidebarContext();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { teamId, navigation } = useAutomationScope();
  const swr = useSWRConfig();
  const { canCreate, loading: authorizationLoading } = useCanCreateAutomation(teamId);
  const requireTeam = searchParams.get("requireTeam") === "true";
  // `?from=<id>` duplicates an existing automation into the create form.
  const sourceId = searchParams.get("from") ?? undefined;
  const duplicateState = useAutomationDuplicate(sourceId, {
    fallbackTeamId: teamId ?? null,
    requireTeam,
  });

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [webhookResult, setWebhookResult] = useState<{
    automationId: string;
    webhookApiKey?: string;
    webhookUrl?: string;
    sentryWebhookUrl?: string;
  } | null>(null);

  useEffect(() => {
    if (!authorizationLoading && !canCreate) router.replace(navigation.list);
  }, [authorizationLoading, canCreate, navigation, router]);

  if (authorizationLoading || !canCreate) return null;

  const collapsedHeader = !isOpen && (
    <header className="border-b border-border-muted flex-shrink-0">
      <div className="px-4 py-3 flex items-center gap-2">
        <CollapsedSidebarControls />
        <Link
          href={navigation.list}
          className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition"
          aria-label="Back to automations"
        >
          <BackIcon className="w-4 h-4" />
        </Link>
      </div>
    </header>
  );

  // The form reads initial values once on mount, so wait for the source.
  if (duplicateState?.status === "loading") {
    return <AutomationFormSkeleton mode="create" header={collapsedHeader} />;
  }
  if (duplicateState?.status === "unavailable") {
    return (
      <div className="h-full flex flex-col">
        {collapsedHeader}
        <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6">
          <ErrorBanner role="alert">
            Couldn&apos;t load your teams, repositories, or environments for the copy. Retrying…
          </ErrorBanner>
          <Link href={navigation.new()}>
            <Button variant="outline" size="sm">
              Start from a blank form
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  // A duplicate (`?from=`) wins over a template id from the gallery; one that
  // fails to load leaves the form blank. Templates never pre-fill a
  // repository, so the repo-required-at-creation invariant holds for them. The
  // form coerces a pre-filled model against the user's enabled set.
  const duplicate = duplicateState?.status === "ready" ? duplicateState.duplicate : undefined;
  const templateId = searchParams.get("template");
  const template = sourceId
    ? undefined
    : automationTemplates.find((candidate) => candidate.id === templateId);
  const initialValues: Partial<AutomationFormValues> = duplicate
    ? duplicate.initialValues
    : { ...template?.prefill, teamId: teamId ?? null };

  const handleSubmit = async (values: AutomationFormValues) => {
    setSubmitting(true);
    setError("");

    try {
      const res = await browserApiFetch("/api/automations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });

      if (res.ok) {
        const data = await res.json();
        await invalidateAutomationCache(swr);
        // For webhook/sentry automations, show post-create info before navigating
        if (data.webhookApiKey || data.sentryWebhookUrl) {
          setWebhookResult({
            automationId: data.automation.id,
            webhookApiKey: data.webhookApiKey,
            webhookUrl: data.webhookUrl,
            sentryWebhookUrl: data.sentryWebhookUrl,
          });
          setSubmitting(false);
        } else {
          router.push(navigation.detail(data.automation.id));
        }
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

  // After webhook creation, show the API key with a continue button
  if (webhookResult) {
    return (
      <div className="h-full flex flex-col">
        {!isOpen && (
          <header className="border-b border-border-muted flex-shrink-0">
            <div className="px-4 py-3 flex items-center gap-2">
              <CollapsedSidebarControls />
            </div>
          </header>
        )}

        <div className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
          <div className="max-w-2xl mx-auto">
            <h1 className="mb-2 text-2xl font-semibold text-foreground sm:text-3xl">
              Automation Created
            </h1>
            {webhookResult.sentryWebhookUrl ? (
              <>
                <p className="text-sm text-muted-foreground mb-6">
                  Configure the webhook URL below in your Sentry Custom Integration settings.
                </p>
                <WebhookConfig
                  webhookUrl={webhookResult.sentryWebhookUrl}
                  automationId={webhookResult.automationId}
                  variant="sentry"
                />
              </>
            ) : (
              <>
                <p className="text-sm text-muted-foreground mb-6">
                  Save the webhook URL and API key below. The API key will not be shown again.
                </p>
                <WebhookConfig
                  webhookUrl={webhookResult.webhookUrl}
                  webhookApiKey={webhookResult.webhookApiKey}
                  automationId={webhookResult.automationId}
                />
              </>
            )}

            <div className="mt-6">
              <Link href={navigation.detail(webhookResult.automationId)}>
                <Button size="sm">Go to Automation</Button>
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {collapsedHeader}

      <div className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
        <div className="max-w-2xl mx-auto">
          <h1 className="mb-6 text-2xl font-semibold text-foreground sm:text-3xl">
            Create Automation
          </h1>

          {error && (
            <ErrorBanner className="mb-4" role="alert">
              {error}
            </ErrorBanner>
          )}

          {duplicateState?.status === "failed" && (
            <ErrorBanner className="mb-4" role="alert">
              Couldn&apos;t load the automation to duplicate.
            </ErrorBanner>
          )}

          {duplicate && (
            <PrefillNotice>
              Duplicating{" "}
              <span className="font-medium text-foreground">{duplicate.sourceName}</span>.
              {duplicate.teamReset &&
                " You can't create automations in its team, so choose a team and targets for the copy."}
              {duplicate.targetsDropped &&
                " Repositories or environments you can't use weren't copied."}{" "}
              Review the details and create it.
            </PrefillNotice>
          )}

          {template && (
            <PrefillNotice>
              Prefilled from the{" "}
              <span className="font-medium text-foreground">{template.title}</span> template. Review
              the details and choose a repository to create it.
            </PrefillNotice>
          )}

          {/* Remount when the query-selected team, team requirement, or duplicate source changes,
              so the form follows the URL. */}
          <AutomationForm
            key={`${teamId ?? ""}:${sourceId ?? ""}:${requireTeam}`}
            mode="create"
            initialValues={initialValues}
            requireTeam={requireTeam}
            onSubmit={handleSubmit}
            submitting={submitting}
          />
        </div>
      </div>
    </div>
  );
}

// Search params are what suspended, so the scope-preserving back link can't be
// built yet; keep the sidebar controls so the layout doesn't shift on load.
function NewAutomationFallback() {
  const { isOpen } = useSidebarContext();
  return (
    <AutomationFormSkeleton
      mode="create"
      header={
        !isOpen && (
          <header className="border-b border-border-muted flex-shrink-0">
            <div className="px-4 py-3 flex items-center gap-2">
              <CollapsedSidebarControls />
            </div>
          </header>
        )
      }
    />
  );
}

export default function NewAutomationPage() {
  return (
    <Suspense fallback={<NewAutomationFallback />}>
      <NewAutomationContent />
    </Suspense>
  );
}

"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useSidebarContext } from "@/components/sidebar-layout";
import {
  AutomationForm,
  type AutomationFormValues,
} from "@/components/automations/automation-form";
import { WebhookConfig } from "@/components/automations/webhook-config";
import { useEnabledModels } from "@/hooks/use-enabled-models";
import { getTemplateById, resolveTemplateInitialValues } from "@/lib/automation-templates";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/error-banner";
import { SidebarIcon, BackIcon } from "@/components/ui/icons";
import { SHORTCUT_LABELS } from "@/lib/keyboard-shortcuts";
import Link from "next/link";

function NewAutomationContent() {
  const { isOpen, toggle } = useSidebarContext();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { enabledModels, loading: loadingModels } = useEnabledModels();

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [webhookResult, setWebhookResult] = useState<{
    automationId: string;
    webhookApiKey?: string;
    webhookUrl?: string;
    sentryWebhookUrl?: string;
  } | null>(null);

  // A template id (from the gallery) pre-fills the form. Repository is never
  // pre-filled, so the repo-required-at-creation invariant is untouched.
  const template = getTemplateById(searchParams.get("template") ?? "");

  // The model selector has no built-in fallback, so a suggested model must be
  // resolved against the user's enabled set before the form mounts (it reads
  // initialValues once). Only block on the enabled list when one is suggested.
  const needsModelResolution = Boolean(template?.prefill.model);
  const initialValues: Partial<AutomationFormValues> | undefined = template
    ? resolveTemplateInitialValues(template.prefill, enabledModels)
    : undefined;

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
          router.push(`/automations/${data.automation.id}`);
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
          <div className="max-w-2xl mx-auto">
            <h1 className="text-3xl font-semibold text-foreground mb-2">Automation Created</h1>
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
              <Link href={`/automations/${webhookResult.automationId}`}>
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
          <h1 className="text-3xl font-semibold text-foreground mb-6">Create Automation</h1>

          {error && (
            <ErrorBanner className="mb-4" role="alert">
              {error}
            </ErrorBanner>
          )}

          {template && (
            <div className="mb-4 rounded-md border border-border-muted bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
              Prefilled from the{" "}
              <span className="font-medium text-foreground">{template.title}</span> template. Review
              the details and choose a repository to create it.
            </div>
          )}

          {needsModelResolution && loadingModels ? (
            <div className="flex justify-center py-12">
              <div className="animate-spin rounded-full h-6 w-6 border-2 border-current border-t-transparent text-muted-foreground" />
            </div>
          ) : (
            <AutomationForm
              mode="create"
              initialValues={initialValues}
              onSubmit={handleSubmit}
              submitting={submitting}
            />
          )}
        </div>
      </div>
    </div>
  );
}

export default function NewAutomationPage() {
  return (
    <Suspense
      fallback={
        <div className="h-full flex items-center justify-center">
          <div className="animate-spin rounded-full h-6 w-6 border-2 border-current border-t-transparent text-muted-foreground" />
        </div>
      }
    >
      <NewAutomationContent />
    </Suspense>
  );
}

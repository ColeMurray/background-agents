"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSidebarContext } from "@/components/sidebar-layout";
import {
  AutomationForm,
  type AutomationFormValues,
} from "@/components/automations/automation-form";
import { WebhookConfig } from "@/components/automations/webhook-config";
import { SidebarIcon, BackIcon } from "@/components/ui/icons";
import { SHORTCUT_LABELS } from "@/lib/keyboard-shortcuts";
import Link from "next/link";

export default function NewAutomationPage() {
  const { isOpen, toggle } = useSidebarContext();
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [webhookResult, setWebhookResult] = useState<{
    automationId: string;
    webhookApiKey?: string;
    webhookUrl?: string;
    sentryWebhookUrl?: string;
  } | null>(null);

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
            <h1 className="text-2xl font-semibold text-foreground mb-2">Automation Created</h1>
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
                <button className="px-4 py-2 bg-accent text-white rounded-md text-sm hover:bg-accent/90 transition">
                  Go to Automation
                </button>
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

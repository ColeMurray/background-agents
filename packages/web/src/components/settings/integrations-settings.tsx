"use client";

import { useMemo, useState } from "react";
import { INTEGRATION_DEFINITIONS, type IntegrationId } from "@open-inspect/shared";
import { useIsMobile } from "@/hooks/use-media-query";
import { GitHubIntegrationSettings } from "@/components/settings/integrations/github-integration-settings";
import { LinearIntegrationSettings } from "@/components/settings/integrations/linear-integration-settings";

export function IntegrationsSettings() {
  const isMobile = useIsMobile();
  const [selectedIntegrationId, setSelectedIntegrationId] = useState<IntegrationId | null>(null);

  const integrations = useMemo(() => INTEGRATION_DEFINITIONS, []);

  const activeIntegrationId =
    selectedIntegrationId ?? (isMobile ? null : (integrations[0]?.id ?? null));

  if (isMobile) {
    return (
      <div>
        <h2 className="text-xl font-semibold text-foreground mb-1">Integrations</h2>
        <p className="text-sm text-muted-foreground mb-6">
          Choose an integration to configure its connection and behavior.
        </p>

        {activeIntegrationId ? (
          <div>
            <button
              type="button"
              onClick={() => setSelectedIntegrationId(null)}
              className="mb-4 flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition"
            >
              <BackIcon />
              Back to integrations
            </button>
            <IntegrationDetail integrationId={activeIntegrationId} />
          </div>
        ) : (
          <IntegrationList
            integrations={integrations}
            selectedIntegrationId={selectedIntegrationId}
            onSelect={setSelectedIntegrationId}
          />
        )}
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-xl font-semibold text-foreground mb-1">Integrations</h2>
      <p className="text-sm text-muted-foreground mb-6">
        Choose an integration to configure its connection and behavior.
      </p>

      <div className="grid grid-cols-[220px_minmax(0,1fr)] gap-6 items-start">
        <IntegrationList
          integrations={integrations}
          selectedIntegrationId={activeIntegrationId}
          onSelect={setSelectedIntegrationId}
        />

        {activeIntegrationId ? (
          <IntegrationDetail integrationId={activeIntegrationId} />
        ) : (
          <EmptyState />
        )}
      </div>
    </div>
  );
}

function IntegrationList({
  integrations,
  selectedIntegrationId,
  onSelect,
}: {
  integrations: typeof INTEGRATION_DEFINITIONS;
  selectedIntegrationId: IntegrationId | null;
  onSelect: (integrationId: IntegrationId) => void;
}) {
  return (
    <div className="border border-border-muted rounded-md bg-background">
      <ul className="divide-y divide-border-muted">
        {integrations.map((integration) => {
          const isSelected = integration.id === selectedIntegrationId;

          return (
            <li key={integration.id}>
              <button
                type="button"
                onClick={() => onSelect(integration.id)}
                className={`w-full text-left px-4 py-3 transition ${
                  isSelected
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                }`}
                aria-current={isSelected ? "page" : undefined}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium">{integration.name}</p>
                    <p className="text-xs mt-1">{integration.description}</p>
                  </div>
                  <ChevronRightIcon className={isSelected ? "text-foreground" : undefined} />
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function IntegrationDetail({ integrationId }: { integrationId: IntegrationId }) {
  if (integrationId === "github") {
    return <GitHubIntegrationSettings />;
  }

  if (integrationId === "linear") {
    return <LinearIntegrationSettings />;
  }

  return <EmptyState />;
}

function EmptyState() {
  return (
    <div className="border border-dashed border-border-muted rounded-md px-6 py-8 text-sm text-muted-foreground">
      Select an integration to manage its settings.
    </div>
  );
}

function BackIcon() {
  return (
    <svg
      className="w-4 h-4"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

function ChevronRightIcon({ className = "text-muted-foreground" }: { className?: string }) {
  return (
    <svg
      className={`w-4 h-4 mt-0.5 ${className}`}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

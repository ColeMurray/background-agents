"use client";

import type { Environment } from "@open-inspect/shared/types/environments";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/error-banner";
import { SecretsEditor } from "@/components/secrets-editor";
import { EnvironmentForm, type EnvironmentFormValues } from "./environment-form";
import { EnvironmentIntegrationSettings } from "./environment-integration-settings";
import { EnvironmentSecretsImport } from "./environment-secrets-import";
import type { EnvironmentAccess, EnvironmentTab } from "./environment-access";

/** One environment's configuration, secrets, and overrides tabs, limited to what access allows. */
export function EnvironmentDetail({
  environment,
  access,
  tab,
  error,
  submitting,
  onTabChange,
  onSubmit,
  onBack,
}: {
  environment: Environment;
  access: EnvironmentAccess;
  tab: EnvironmentTab;
  error: string;
  submitting: boolean;
  onTabChange: (tab: EnvironmentTab) => void;
  onSubmit: (values: EnvironmentFormValues) => void;
  onBack: () => void;
}) {
  const backButton = (
    <Button variant="outline" size="xs" onClick={onBack}>
      Back to environments
    </Button>
  );
  const activeTab = access.tabs.includes(tab) ? tab : access.tabs[0];
  if (!activeTab) return backButton;

  return (
    <div>
      <h2 className="text-xl font-semibold text-foreground mb-1">{environment.name}</h2>
      <p className="text-sm text-muted-foreground mb-4">
        {environment.description || "Edit this environment."}
      </p>

      <div className="flex items-center gap-1 border-b border-border-muted mb-4">
        {access.tabs.map((entry) => (
          <button
            type="button"
            key={entry}
            onClick={() => onTabChange(entry)}
            className={`px-3 py-2 text-sm capitalize transition border-b-2 -mb-px ${
              activeTab === entry
                ? "border-accent text-foreground font-medium"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {entry}
          </button>
        ))}
      </div>

      {error && <ErrorBanner className="mb-4">{error}</ErrorBanner>}

      {activeTab === "configuration" ? (
        <EnvironmentForm
          mode="edit"
          initialValues={environment}
          onSubmit={onSubmit}
          onCancel={onBack}
          submitting={submitting}
        />
      ) : activeTab === "secrets" ? (
        <div>
          <p className="text-xs text-muted-foreground">
            Sessions launched from this environment get global secrets plus these — repository
            secrets do not carry over automatically. Changing secrets invalidates prebuilt images
            and triggers a rebuild.
          </p>
          <SecretsEditor
            scope="environment"
            environmentId={environment.id}
            disabled={!access.canEditSecrets}
          />
          {access.canImportRepoSecrets && (
            <EnvironmentSecretsImport
              environmentId={environment.id}
              repositories={environment.repositories}
            />
          )}
          <div className="mt-4">{backButton}</div>
        </div>
      ) : (
        <div>
          <EnvironmentIntegrationSettings
            environmentId={environment.id}
            repositories={environment.repositories}
            canManage={access.canEditOverrides}
          />
          <div className="mt-4">{backButton}</div>
        </div>
      )}
    </div>
  );
}

"use client";

import useSWR from "swr";
import {
  GITHUB_AUTOFIX_DEFAULTS,
  type GitHubGlobalConfig,
} from "@open-inspect/shared/types/integrations";
import type { EnrichedRepository } from "@open-inspect/shared/types/repository-catalog";
import { useEnabledModels } from "@/hooks/use-enabled-models";
import { IntegrationSettingsSkeleton } from "./integration-settings-skeleton";
import { CommitSigningSettings } from "./commit-signing-settings";
import { GlobalSettingsSection } from "./github-global-settings-section";
import { RepoOverridesSection, type RepoSettingsEntry } from "./github-repo-overrides-section";
import { IntegrationSettingsSection } from "./integration-settings-section";
import { useCurrentUserAuthorization } from "@/hooks/use-current-user-authorization";

const GLOBAL_SETTINGS_KEY = "/api/integration-settings/github";
const REPO_SETTINGS_KEY = "/api/integration-settings/github/repos";

interface GlobalResponse {
  settings: GitHubGlobalConfig | null;
}

interface RepoListResponse {
  repos: RepoSettingsEntry[];
}

interface ReposResponse {
  repos: EnrichedRepository[];
}

/**
 * Displays GitHub integration settings with global and repository edits gated by their respective permissions.
 */
export function GitHubIntegrationSettings() {
  const { hasPermission } = useCurrentUserAuthorization();
  const canManageGlobal = hasPermission("integrations.manage");
  const canManageRepos = hasPermission("repositories.settings.manage");
  const { data: globalData, isLoading: globalLoading } =
    useSWR<GlobalResponse>(GLOBAL_SETTINGS_KEY);
  const { data: repoSettingsData, isLoading: repoSettingsLoading } =
    useSWR<RepoListResponse>(REPO_SETTINGS_KEY);
  const { data: reposData } = useSWR<ReposResponse>("/api/repos");
  const { enabledModelOptions } = useEnabledModels();

  if (globalLoading || repoSettingsLoading) {
    return <IntegrationSettingsSkeleton />;
  }

  const settings = globalData?.settings;
  const repoOverrides = repoSettingsData?.repos ?? [];
  const availableRepos = reposData?.repos ?? [];
  const defaultAutoReviewOnOpen = settings?.defaults?.autoReviewOnOpen ?? true;
  const defaultAutofix = {
    ...GITHUB_AUTOFIX_DEFAULTS,
    ...settings?.defaults?.autofix,
  };

  return (
    <div>
      <h2 className="text-lg font-semibold text-foreground mb-1">GitHub Bot</h2>
      <p className="text-sm text-muted-foreground mb-6">
        Configure automated PR reviews and comment-triggered actions.
      </p>

      <IntegrationSettingsSection
        title="Connection"
        description="GitHub App access used for repo discovery and scope."
      >
        {availableRepos.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            Repository access is available. You can limit the bot to selected repositories below.
          </p>
        ) : (
          <p className="text-sm text-warning bg-warning-muted border border-warning/20 px-4 py-3 rounded-sm">
            GitHub App is not configured or has no accessible repositories. Repository filtering is
            currently unavailable.
          </p>
        )}
      </IntegrationSettingsSection>

      <CommitSigningSettings />

      <fieldset disabled={!canManageGlobal} className="min-w-0">
        <GlobalSettingsSection
          settings={settings}
          availableRepos={availableRepos}
          enabledModelOptions={enabledModelOptions}
        />
      </fieldset>

      <IntegrationSettingsSection
        title="Repository Overrides"
        description="Set model, reasoning, and custom instruction overrides for specific repositories."
      >
        <fieldset disabled={!canManageRepos} className="min-w-0">
          <RepoOverridesSection
            overrides={repoOverrides}
            availableRepos={availableRepos}
            enabledModelOptions={enabledModelOptions}
            defaultAutoReviewOnOpen={defaultAutoReviewOnOpen}
            defaultAutofix={defaultAutofix}
          />
        </fieldset>
      </IntegrationSettingsSection>
    </div>
  );
}

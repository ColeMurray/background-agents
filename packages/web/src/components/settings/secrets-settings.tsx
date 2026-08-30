"use client";

import { SecretsEditor } from "@/components/secrets-editor";
import { useRepos } from "@/hooks/use-repos";
import { useState } from "react";
import { ChevronDownIcon, CheckIcon } from "@/components/ui/icons";
import { Combobox } from "@/components/ui/combobox";
import { useCurrentUserAuthorization } from "@/hooks/use-current-user-authorization";

const GLOBAL_SCOPE = "__global__";

/**
 * Exposes global and repository secret editors only for scopes the user is authorized to manage.
 */
export function SecretsSettings() {
  const { hasPermission } = useCurrentUserAuthorization();
  const canManageGlobal = hasPermission("global_secrets.manage");
  const canManageRepos =
    hasPermission("repositories.secrets.manage") && hasPermission("repositories.read");
  const { repos, loading: loadingRepos } = useRepos(canManageRepos);
  const [selectedRepo, setSelectedRepo] = useState(canManageGlobal ? GLOBAL_SCOPE : "");

  const selectedRepoObj = repos.find((r) => r.fullName === selectedRepo);
  const isGlobal = selectedRepo === GLOBAL_SCOPE;
  const displayRepoName = isGlobal
    ? "All Repositories (Global)"
    : selectedRepoObj
      ? selectedRepoObj.fullName
      : loadingRepos
        ? "Loading..."
        : "Select a repository";

  return (
    <div>
      <h2 className="text-xl font-semibold text-foreground mb-1">Secrets</h2>
      <p className="text-sm text-muted-foreground mb-6">
        Manage environment variables that are injected into sandbox sessions.
      </p>

      {/* Repo selector */}
      <div className="mb-6">
        <label
          id="secrets-repository-label"
          htmlFor="secrets-repository"
          className="block text-sm font-medium text-foreground mb-1.5"
        >
          Repository
        </label>
        <Combobox
          id="secrets-repository"
          labelId="secrets-repository-label"
          value={selectedRepo}
          onChange={setSelectedRepo}
          items={(canManageRepos ? repos : []).map((repo) => ({
            value: repo.fullName,
            label: repo.name,
            description: `${repo.owner}${repo.private ? " \u2022 private" : ""}`,
          }))}
          searchable
          searchPlaceholder="Search repositories..."
          filterFn={(option, query) =>
            option.label.toLowerCase().includes(query) ||
            (option.description?.toLowerCase().includes(query) ?? false) ||
            String(option.value).toLowerCase().includes(query)
          }
          direction="down"
          dropdownWidth="w-full max-w-sm"
          disabled={loadingRepos || (!canManageGlobal && !canManageRepos)}
          triggerClassName="w-full max-w-sm flex items-center justify-between px-3 py-2 text-sm border border-border bg-input text-foreground hover:border-foreground/30 disabled:opacity-50 disabled:cursor-not-allowed transition"
          prependContent={({ select }) =>
            canManageGlobal ? (
              <>
                <button
                  type="button"
                  onClick={() => select(GLOBAL_SCOPE)}
                  className={`w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-muted transition ${
                    isGlobal ? "text-foreground" : "text-muted-foreground"
                  }`}
                >
                  <div className="flex flex-col items-start text-left">
                    <span className="font-medium">All Repositories (Global)</span>
                    <span className="text-xs text-secondary-foreground">
                      Shared across all repositories
                    </span>
                  </div>
                  {isGlobal && <CheckIcon className="w-4 h-4 text-accent" />}
                </button>
                {repos.length > 0 && <div className="border-t border-border my-1" />}
              </>
            ) : null
          }
        >
          <span className="truncate">{displayRepoName}</span>
          <ChevronDownIcon className="w-3 h-3 flex-shrink-0" />
        </Combobox>
      </div>

      {isGlobal && canManageGlobal ? (
        <SecretsEditor scope="global" />
      ) : canManageRepos ? (
        <SecretsEditor
          scope="repo"
          owner={selectedRepoObj?.owner}
          name={selectedRepoObj?.name}
          disabled={loadingRepos}
        />
      ) : null}
    </div>
  );
}

"use client";

import { SecretsEditor } from "@/components/secrets-editor";
import { useRepos } from "@/hooks/use-repos";
import { useState } from "react";
import { ChevronDownIcon, CheckIcon } from "@/components/ui/icons";
import { Combobox } from "@/components/ui/combobox";

const GLOBAL_SCOPE = "__global__";

export function SecretsSettings() {
  const { repos, loading: loadingRepos } = useRepos();
  const [selectedRepo, setSelectedRepo] = useState(GLOBAL_SCOPE);

  const selectedRepoObj = repos.find((r) => r.name === selectedRepo);
  const isGlobal = selectedRepo === GLOBAL_SCOPE;
  const displayRepoName = isGlobal
    ? "All Repositories (Global)"
    : selectedRepoObj
      ? selectedRepoObj.name
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
      <div className="mb-4">
        <label className="block text-sm font-medium text-foreground mb-1.5">Repository</label>
        <Combobox
          value={selectedRepo}
          onChange={setSelectedRepo}
          items={repos.map((repo) => ({
            value: repo.name,
            label: repo.name,
            description: repo.path,
          }))}
          searchable
          searchPlaceholder="Search repositories..."
          filterFn={(option, query) =>
            option.label.toLowerCase().includes(query) ||
            (option.description?.toLowerCase().includes(query) ?? false)
          }
          direction="down"
          dropdownWidth="w-full max-w-sm"
          disabled={loadingRepos}
          triggerClassName="w-full max-w-sm flex items-center justify-between px-3 py-2 text-sm border border-border bg-input text-foreground hover:border-foreground/30 disabled:opacity-50 disabled:cursor-not-allowed transition"
          prependContent={({ select }) => (
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
          )}
        >
          <span className="truncate">{displayRepoName}</span>
          <ChevronDownIcon className="w-3 h-3 flex-shrink-0" />
        </Combobox>
      </div>

      {isGlobal ? (
        <SecretsEditor scope="global" disabled={loadingRepos} />
      ) : (
        <SecretsEditor
          scope="repo"
          owner={selectedRepoObj?.name}
          name={selectedRepoObj?.name}
          disabled={loadingRepos}
        />
      )}
    </div>
  );
}

"use client";

import { useState, useEffect, useRef } from "react";
import { SecretsEditor } from "@/components/secrets-editor";
import { useRepos } from "@/hooks/use-repos";

const GLOBAL_SCOPE = "__global__";

export function SecretsSettings() {
  const { repos, loading: loadingRepos } = useRepos();
  const [selectedRepo, setSelectedRepo] = useState(GLOBAL_SCOPE);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [repoSearchQuery, setRepoSearchQuery] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);
  const repoSearchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    if (!dropdownOpen) {
      setRepoSearchQuery("");
      return;
    }

    const id = requestAnimationFrame(() => repoSearchInputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [dropdownOpen]);

  const selectedRepoObj = repos.find((r) => r.fullName === selectedRepo);
  const isGlobal = selectedRepo === GLOBAL_SCOPE;
  const displayRepoName = isGlobal
    ? "All Repositories (Global)"
    : selectedRepoObj
      ? selectedRepoObj.fullName
      : loadingRepos
        ? "Loading..."
        : "Select a repository";
  const normalizedRepoSearchQuery = repoSearchQuery.trim().toLowerCase();
  const filteredRepos = repos.filter((repo) => {
    if (!normalizedRepoSearchQuery) return true;
    return (
      repo.name.toLowerCase().includes(normalizedRepoSearchQuery) ||
      repo.owner.toLowerCase().includes(normalizedRepoSearchQuery) ||
      repo.fullName.toLowerCase().includes(normalizedRepoSearchQuery)
    );
  });

  return (
    <div>
      <h2 className="text-xl font-semibold text-foreground mb-1">Secrets</h2>
      <p className="text-sm text-muted-foreground mb-6">
        Manage environment variables that are injected into sandbox sessions.
      </p>

      {/* Repo selector */}
      <div className="mb-4">
        <label className="block text-sm font-medium text-foreground mb-1.5">Repository</label>
        <div className="relative" ref={dropdownRef}>
          <button
            type="button"
            onClick={() => setDropdownOpen(!dropdownOpen)}
            disabled={loadingRepos}
            className="w-full max-w-sm flex items-center justify-between px-3 py-2 text-sm border border-border bg-input text-foreground hover:border-foreground/30 disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            <span className="truncate">{displayRepoName}</span>
            <ChevronIcon />
          </button>

          {dropdownOpen && (
            <div className="absolute top-full left-0 mt-1 w-full max-w-sm bg-background shadow-lg border border-border z-50">
              <div className="p-2 border-b border-border-muted">
                <input
                  ref={repoSearchInputRef}
                  type="text"
                  value={repoSearchQuery}
                  onChange={(e) => setRepoSearchQuery(e.target.value)}
                  placeholder="Search repositories..."
                  className="w-full px-2 py-1.5 text-sm bg-input border border-border focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent placeholder:text-secondary-foreground text-foreground"
                />
              </div>

              <div className="max-h-56 overflow-y-auto py-1">
                {/* Global entry */}
                <button
                  type="button"
                  onClick={() => {
                    setSelectedRepo(GLOBAL_SCOPE);
                    setDropdownOpen(false);
                  }}
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
                  {isGlobal && <CheckIcon />}
                </button>

                {filteredRepos.length > 0 && <div className="border-t border-border my-1" />}

                {filteredRepos.length === 0 ? (
                  <div className="px-3 py-2 text-sm text-muted-foreground">
                    No repositories match {repoSearchQuery.trim()}
                  </div>
                ) : (
                  filteredRepos.map((repo) => (
                    <button
                      key={repo.id}
                      type="button"
                      onClick={() => {
                        setSelectedRepo(repo.fullName);
                        setDropdownOpen(false);
                      }}
                      className={`w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-muted transition ${
                        selectedRepo === repo.fullName ? "text-foreground" : "text-muted-foreground"
                      }`}
                    >
                      <div className="flex flex-col items-start text-left">
                        <span className="font-medium truncate max-w-[280px]">{repo.name}</span>
                        <span className="text-xs text-secondary-foreground truncate max-w-[280px]">
                          {repo.owner}
                          {repo.private && " \u00b7 private"}
                        </span>
                      </div>
                      {selectedRepo === repo.fullName && <CheckIcon />}
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {isGlobal ? (
        <SecretsEditor scope="global" disabled={loadingRepos} />
      ) : (
        <SecretsEditor
          scope="repo"
          owner={selectedRepoObj?.owner}
          name={selectedRepoObj?.name}
          disabled={loadingRepos}
        />
      )}
    </div>
  );
}

function ChevronIcon() {
  return (
    <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg className="w-4 h-4 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
    </svg>
  );
}

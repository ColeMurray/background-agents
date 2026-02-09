"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { SecretsEditor } from "@/components/secrets-editor";

const GLOBAL_SCOPE = "__global__";

interface Repo {
  id: number;
  fullName: string;
  owner: string;
  name: string;
  description: string | null;
  private: boolean;
}

export function SecretsSettings() {
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState(GLOBAL_SCOPE);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const fetchRepos = useCallback(async () => {
    setLoadingRepos(true);
    try {
      const res = await fetch("/api/repos");
      if (res.ok) {
        const data = await res.json();
        const repoList = data.repos || [];
        setRepos(repoList);
      }
    } catch (error) {
      console.error("Failed to fetch repos:", error);
    } finally {
      setLoadingRepos(false);
    }
  }, []);

  useEffect(() => {
    fetchRepos();
  }, [fetchRepos]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

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
            <div className="absolute top-full left-0 mt-1 w-full max-w-sm max-h-64 overflow-y-auto bg-background shadow-lg border border-border py-1 z-50">
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

              {repos.length > 0 && <div className="border-t border-border my-1" />}

              {repos.map((repo) => (
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
              ))}
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

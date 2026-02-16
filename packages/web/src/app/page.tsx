"use client";

import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import { SidebarLayout, useSidebarContext } from "@/components/sidebar-layout";
import { formatModelNameLower } from "@/lib/format";
import { MODEL_OPTIONS, DEFAULT_MODEL, getDefaultReasoningEffort } from "@open-inspect/shared";
import { ReasoningEffortPills } from "@/components/reasoning-effort-pills";
import { Button } from "@/components/ui/button";

interface Repo {
  id: number;
  fullName: string;
  owner: string;
  name: string;
  description: string | null;
  private: boolean;
}

export default function Home() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [repos, setRepos] = useState<Repo[]>([]);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState<string>("");
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_MODEL);
  const [reasoningEffort, setReasoningEffort] = useState<string | undefined>(
    getDefaultReasoningEffort(DEFAULT_MODEL)
  );
  const [prompt, setPrompt] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const sessionCreationPromise = useRef<Promise<string | null> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const pendingConfigRef = useRef<{ repo: string; model: string } | null>(null);

  const fetchRepos = useCallback(async () => {
    setLoadingRepos(true);
    try {
      const res = await fetch("/api/repos");
      if (res.ok) {
        const data = await res.json();
        const repoList = data.repos || [];
        setRepos(repoList);
        if (repoList.length > 0) {
          setSelectedRepo((current) => current || repoList[0].fullName);
        }
      }
    } catch (error) {
      console.error("Failed to fetch repos:", error);
    } finally {
      setLoadingRepos(false);
    }
  }, []);

  // use status as stable dep instead of session object (unstable reference)
  const isAuthenticated = status === "authenticated";
  useEffect(() => {
    if (isAuthenticated) {
      fetchRepos();
    }
  }, [isAuthenticated, fetchRepos]);

  useEffect(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setPendingSessionId(null);
    setIsCreatingSession(false);
    sessionCreationPromise.current = null;
    pendingConfigRef.current = null;
  }, [selectedRepo, selectedModel]);

  const createSessionForWarming = useCallback(async () => {
    if (pendingSessionId) return pendingSessionId;
    if (sessionCreationPromise.current) return sessionCreationPromise.current;
    if (!selectedRepo) return null;

    setIsCreatingSession(true);
    const [owner, name] = selectedRepo.split("/");
    const currentConfig = { repo: selectedRepo, model: selectedModel };
    pendingConfigRef.current = currentConfig;

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    const promise = (async () => {
      try {
        const res = await fetch("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            repoOwner: owner,
            repoName: name,
            model: selectedModel,
            reasoningEffort,
          }),
          signal: abortController.signal,
        });

        if (res.ok) {
          const data = await res.json();
          if (
            pendingConfigRef.current?.repo === currentConfig.repo &&
            pendingConfigRef.current?.model === currentConfig.model
          ) {
            setPendingSessionId(data.sessionId);
            return data.sessionId as string;
          }
          return null;
        }
        return null;
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return null;
        }
        console.error("Failed to create session for warming:", error);
        return null;
      } finally {
        if (abortControllerRef.current === abortController) {
          setIsCreatingSession(false);
          sessionCreationPromise.current = null;
          abortControllerRef.current = null;
        }
      }
    })();

    sessionCreationPromise.current = promise;
    return promise;
  }, [selectedRepo, selectedModel, reasoningEffort, pendingSessionId]);

  const handleModelChange = useCallback((model: string) => {
    setSelectedModel(model);
    setReasoningEffort(getDefaultReasoningEffort(model));
  }, []);

  const handlePromptChange = (value: string) => {
    const wasEmpty = prompt.length === 0;
    setPrompt(value);
    if (wasEmpty && value.length > 0 && !pendingSessionId && !isCreatingSession && selectedRepo) {
      createSessionForWarming();
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim()) return;
    if (!selectedRepo) {
      setError("Please select a repository");
      return;
    }

    setCreating(true);
    setError("");

    try {
      let sessionId = pendingSessionId;
      if (!sessionId) {
        sessionId = await createSessionForWarming();
      }

      if (!sessionId) {
        setError("Failed to create session");
        setCreating(false);
        return;
      }

      const res = await fetch(`/api/sessions/${sessionId}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: prompt,
          model: selectedModel,
          reasoningEffort,
        }),
      });

      if (res.ok) {
        router.push(`/session/${sessionId}`);
      } else {
        const data = await res.json();
        setError(data.error || "Failed to send prompt");
        setCreating(false);
      }
    } catch (_error) {
      setError("Failed to create session");
      setCreating(false);
    }
  };

  if (status === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-clay-100">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-ash-900" />
      </div>
    );
  }

  return (
    <SidebarLayout>
      <HomeContent
        isAuthenticated={!!session}
        repos={repos}
        loadingRepos={loadingRepos}
        selectedRepo={selectedRepo}
        setSelectedRepo={setSelectedRepo}
        selectedModel={selectedModel}
        setSelectedModel={handleModelChange}
        reasoningEffort={reasoningEffort}
        setReasoningEffort={setReasoningEffort}
        prompt={prompt}
        handlePromptChange={handlePromptChange}
        creating={creating}
        isCreatingSession={isCreatingSession}
        error={error}
        handleSubmit={handleSubmit}
      />
    </SidebarLayout>
  );
}

function HomeContent({
  isAuthenticated,
  repos,
  loadingRepos,
  selectedRepo,
  setSelectedRepo,
  selectedModel,
  setSelectedModel,
  reasoningEffort,
  setReasoningEffort,
  prompt,
  handlePromptChange,
  creating,
  isCreatingSession,
  error,
  handleSubmit,
}: {
  isAuthenticated: boolean;
  repos: Repo[];
  loadingRepos: boolean;
  selectedRepo: string;
  setSelectedRepo: (value: string) => void;
  selectedModel: string;
  setSelectedModel: (value: string) => void;
  reasoningEffort: string | undefined;
  setReasoningEffort: (value: string | undefined) => void;
  prompt: string;
  handlePromptChange: (value: string) => void;
  creating: boolean;
  isCreatingSession: boolean;
  error: string;
  handleSubmit: (e: React.FormEvent) => void;
}) {
  const { isOpen, toggle } = useSidebarContext();
  const [repoDropdownOpen, setRepoDropdownOpen] = useState(false);
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const repoDropdownRef = useRef<HTMLDivElement>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (repoDropdownRef.current && !repoDropdownRef.current.contains(event.target as Node)) {
        setRepoDropdownOpen(false);
      }
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(event.target as Node)) {
        setModelDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const selectedRepoObj = repos.find((r) => r.fullName === selectedRepo);
  const displayRepoName = selectedRepoObj ? selectedRepoObj.name : "Select repo";

  return (
    <div className="h-full flex flex-col">
      {/* header - matches DashboardPageLayout pattern */}
      <header className="flex items-center justify-between w-full sticky top-0 z-20 backdrop-blur-md h-20 px-6 lg:px-12 xl:px-20 bg-clay-100/90 flex-shrink-0">
        <div className="flex items-center gap-3">
          {!isOpen && (
            <Button
              variant="ghost"
              size="xs"
              onClick={toggle}
              className="size-10 rounded-full"
              title="Open sidebar"
            >
              <SidebarToggleIcon />
            </Button>
          )}
          <h1 className="text-2xl sm:text-3xl font-semibold text-ash-900 font-clash">
            New Session
          </h1>
        </div>
      </header>

      <div className="flex-1 flex flex-col items-center justify-center px-4 lg:px-12 xl:px-20 pb-8">
        <div className="w-full max-w-2xl">
          {/* welcome text */}
          <div className="text-center mb-8">
            <h1 className="text-3xl font-semibold text-ash-900 font-clash tracking-tight mb-2">
              Welcome to Wrench
            </h1>
            {isAuthenticated ? (
              <p className="text-ash-500">Ask a question or describe what you want to build</p>
            ) : (
              <p className="text-ash-500">Sign in to start a new session</p>
            )}
          </div>

          {/* Input box - only show when authenticated */}
          {isAuthenticated && (
            <form onSubmit={handleSubmit}>
              {error && (
                <div className="mb-4 bg-lava-100 text-lava-600 px-4 py-3 border border-lava-200 rounded-lg text-sm">
                  {error}
                </div>
              )}

              <div className="border border-ash-300 bg-white rounded-lg">
                {/* Text input area */}
                <div className="relative">
                  <textarea
                    ref={inputRef}
                    value={prompt}
                    onChange={(e) => handlePromptChange(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="What do you want to build?"
                    disabled={creating}
                    className="w-full resize-none bg-transparent px-4 pt-4 pb-12 focus:outline-none text-ash-900 placeholder:text-ash-400 disabled:opacity-50"
                    rows={3}
                  />
                  {/* Submit button */}
                  <div className="absolute bottom-3 right-3 flex items-center gap-2">
                    {isCreatingSession && (
                      <span className="text-xs text-rebolt-500">Warming sandbox...</span>
                    )}
                    <Button
                      variant="ghost"
                      size="xs"
                      type="submit"
                      disabled={!prompt.trim() || creating || !selectedRepo}
                      className="p-2 h-auto text-ash-400"
                      title="Send"
                    >
                      {creating ? (
                        <div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                      ) : (
                        <svg
                          className="w-5 h-5"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M5 10l7-7m0 0l7 7m-7-7v18"
                          />
                        </svg>
                      )}
                    </Button>
                  </div>
                </div>

                {/* Footer row with repo and model selectors */}
                <div className="flex items-center justify-between px-4 py-2 border-t border-ash-200">
                  {/* left side - repo selector + model selector */}
                  <div className="flex items-center gap-4">
                    {/* repo selector */}
                    <div className="relative" ref={repoDropdownRef}>
                      <Button
                        variant="ghost"
                        size="xs"
                        type="button"
                        onClick={() => !creating && setRepoDropdownOpen(!repoDropdownOpen)}
                        disabled={creating || loadingRepos}
                        className="gap-1.5 h-auto px-1 text-ash-500"
                      >
                        <RepoIcon />
                        <span>{loadingRepos ? "Loading..." : displayRepoName}</span>
                        <ChevronIcon />
                      </Button>

                      {repoDropdownOpen && repos.length > 0 && (
                        <div className="absolute bottom-full left-0 mb-2 w-72 max-h-64 overflow-y-auto bg-white shadow-lg border border-ash-200 rounded-lg py-1 z-50">
                          {repos.map((repo) => (
                            <Button
                              key={repo.id}
                              variant="ghost"
                              size="xs"
                              type="button"
                              onClick={() => {
                                setSelectedRepo(repo.fullName);
                                setRepoDropdownOpen(false);
                              }}
                              className={`w-full justify-between ${
                                selectedRepo === repo.fullName ? "text-ash-900" : "text-ash-500"
                              }`}
                            >
                              <div className="flex flex-col items-start text-left">
                                <span className="font-medium truncate max-w-[200px]">
                                  {repo.name}
                                </span>
                                <span className="text-xs text-ash-400 truncate max-w-[200px]">
                                  {repo.owner}
                                  {repo.private && " • private"}
                                </span>
                              </div>
                              {selectedRepo === repo.fullName && <CheckIcon />}
                            </Button>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* model selector */}
                    <div className="relative" ref={modelDropdownRef}>
                      <Button
                        variant="ghost"
                        size="xs"
                        type="button"
                        onClick={() => !creating && setModelDropdownOpen(!modelDropdownOpen)}
                        disabled={creating}
                        className="gap-1 h-auto px-1 text-ash-500"
                      >
                        <ModelIcon />
                        <span>{formatModelNameLower(selectedModel)}</span>
                      </Button>

                      {modelDropdownOpen && (
                        <div className="absolute bottom-full left-0 mb-2 w-56 bg-white shadow-lg border border-ash-200 rounded-lg py-1 z-50">
                          {MODEL_OPTIONS.map((group, groupIdx) => (
                            <div key={group.category}>
                              <div
                                className={`px-3 py-1.5 text-xs font-medium text-ash-400 uppercase tracking-wider ${
                                  groupIdx > 0 ? "border-t border-ash-200 mt-1" : ""
                                }`}
                              >
                                {group.category}
                              </div>
                              {group.models.map((model) => (
                                <Button
                                  key={model.id}
                                  variant="ghost"
                                  size="xs"
                                  type="button"
                                  onClick={() => {
                                    setSelectedModel(model.id);
                                    setModelDropdownOpen(false);
                                  }}
                                  className={`w-full justify-between ${
                                    selectedModel === model.id ? "text-ash-900" : "text-ash-500"
                                  }`}
                                >
                                  <div className="flex flex-col items-start">
                                    <span className="font-medium">{model.name}</span>
                                    <span className="text-xs text-ash-400">
                                      {model.description}
                                    </span>
                                  </div>
                                  {selectedModel === model.id && <CheckIcon />}
                                </Button>
                              ))}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Reasoning effort pills */}
                    <ReasoningEffortPills
                      selectedModel={selectedModel}
                      reasoningEffort={reasoningEffort}
                      onSelect={setReasoningEffort}
                      disabled={creating}
                    />
                  </div>

                  {/* right side - agent label */}
                  <span className="text-sm text-ash-400">build agent</span>
                </div>
              </div>

              {selectedRepoObj && (
                <div className="mt-3 text-center">
                  <Link
                    href="/settings"
                    className="text-xs text-ash-400 hover:text-ash-900 transition-colors"
                  >
                    Manage secrets and settings
                  </Link>
                </div>
              )}

              {repos.length === 0 && !loadingRepos && (
                <p className="mt-3 text-sm text-ash-500 text-center">
                  No repositories found. Make sure you have granted access to your repositories.
                </p>
              )}
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

function SidebarToggleIcon() {
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
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
    </svg>
  );
}

function RepoIcon() {
  return (
    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 16 16">
      <path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z" />
    </svg>
  );
}

function ModelIcon() {
  return (
    <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
      <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg className="w-4 h-4 text-rebolt-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
    </svg>
  );
}

"use client";

import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { mutate } from "swr";
import { useState, useEffect, useRef, useCallback, useMemo, useId } from "react";
import Link from "next/link";
import { useSidebarContext } from "@/components/sidebar-layout";
import { SidebarToggleIcon } from "@/components/sidebar-toggle-icon";
import { formatModelNameLower } from "@/lib/format";
import { SHORTCUT_LABELS } from "@/lib/keyboard-shortcuts";
import {
  DEFAULT_MODEL,
  getDefaultReasoningEffort,
  isValidReasoningEffort,
  type ModelCategory,
} from "@open-inspect/shared";
import { useEnabledModels } from "@/hooks/use-enabled-models";
import { useRepos, type Repo } from "@/hooks/use-repos";
import { ReasoningEffortPills } from "@/components/reasoning-effort-pills";

const LAST_SELECTED_REPO_STORAGE_KEY = "open-inspect-last-selected-repo";
const LAST_SELECTED_MODEL_STORAGE_KEY = "open-inspect-last-selected-model";
const LAST_SELECTED_REASONING_EFFORT_STORAGE_KEY = "open-inspect-last-selected-reasoning-effort";

export default function Home() {
  const { data: session } = useSession();
  const router = useRouter();
  const { repos, loading: loadingRepos } = useRepos();
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
  const hasHydratedModelPreferences = useRef(false);
  const { enabledModels, enabledModelOptions } = useEnabledModels();

  // Auto-select repo when repos load
  useEffect(() => {
    if (repos.length > 0 && !selectedRepo) {
      const lastSelectedRepo = localStorage.getItem(LAST_SELECTED_REPO_STORAGE_KEY);
      const hasLastSelectedRepo = repos.some((repo) => repo.fullName === lastSelectedRepo);
      const defaultRepo =
        (hasLastSelectedRepo ? lastSelectedRepo : repos[0].fullName) ?? repos[0].fullName;
      setSelectedRepo(defaultRepo);
    }
  }, [repos, selectedRepo]);

  useEffect(() => {
    if (!selectedRepo) return;
    localStorage.setItem(LAST_SELECTED_REPO_STORAGE_KEY, selectedRepo);
  }, [selectedRepo]);

  useEffect(() => {
    if (enabledModels.length === 0 || hasHydratedModelPreferences.current) return;

    const storedModel = localStorage.getItem(LAST_SELECTED_MODEL_STORAGE_KEY);
    const selectedModelFromStorage =
      storedModel && enabledModels.includes(storedModel)
        ? storedModel
        : (enabledModels[0] ?? DEFAULT_MODEL);

    const storedReasoningEffort = localStorage.getItem(LAST_SELECTED_REASONING_EFFORT_STORAGE_KEY);
    const reasoningEffortFromStorage =
      storedReasoningEffort &&
      isValidReasoningEffort(selectedModelFromStorage, storedReasoningEffort)
        ? storedReasoningEffort
        : getDefaultReasoningEffort(selectedModelFromStorage);

    setSelectedModel(selectedModelFromStorage);
    setReasoningEffort(reasoningEffortFromStorage);
    hasHydratedModelPreferences.current = true;
  }, [enabledModels]);

  useEffect(() => {
    if (!hasHydratedModelPreferences.current) return;
    localStorage.setItem(LAST_SELECTED_MODEL_STORAGE_KEY, selectedModel);

    if (reasoningEffort) {
      localStorage.setItem(LAST_SELECTED_REASONING_EFFORT_STORAGE_KEY, reasoningEffort);
      return;
    }

    localStorage.removeItem(LAST_SELECTED_REASONING_EFFORT_STORAGE_KEY);
  }, [selectedModel, reasoningEffort]);

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

  // Reset selections when model preferences change
  useEffect(() => {
    if (enabledModels.length > 0 && !enabledModels.includes(selectedModel)) {
      const fallback = enabledModels[0] ?? DEFAULT_MODEL;
      setSelectedModel(fallback);
      setReasoningEffort(getDefaultReasoningEffort(fallback));
      return;
    }

    if (reasoningEffort && !isValidReasoningEffort(selectedModel, reasoningEffort)) {
      setReasoningEffort(getDefaultReasoningEffort(selectedModel));
    }
  }, [enabledModels, selectedModel, reasoningEffort]);

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
        mutate("/api/sessions");
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

  return (
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
      modelOptions={enabledModelOptions}
    />
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
  modelOptions,
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
  modelOptions: ModelCategory[];
}) {
  const { isOpen, toggle } = useSidebarContext();
  const [repoDropdownOpen, setRepoDropdownOpen] = useState(false);
  const [repoSearchQuery, setRepoSearchQuery] = useState("");
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [activeRepoIndex, setActiveRepoIndex] = useState(-1);
  const [activeModelIndex, setActiveModelIndex] = useState(-1);
  const repoDropdownRef = useRef<HTMLDivElement>(null);
  const repoButtonRef = useRef<HTMLButtonElement>(null);
  const repoSearchInputRef = useRef<HTMLInputElement>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const modelButtonRef = useRef<HTMLButtonElement>(null);
  const modelListRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const repoListboxId = useId();
  const modelListboxId = useId();

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

  useEffect(() => {
    if (!repoDropdownOpen) {
      setRepoSearchQuery("");
      return;
    }

    const id = requestAnimationFrame(() => repoSearchInputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [repoDropdownOpen]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const selectedRepoObj = repos.find((r) => r.fullName === selectedRepo);
  const displayRepoName = selectedRepoObj ? selectedRepoObj.name : "Select repo";
  const filteredRepos = useMemo(() => {
    const query = repoSearchQuery.trim().toLowerCase();
    if (!query) return repos;
    return repos.filter(
      (repo) =>
        repo.name.toLowerCase().includes(query) ||
        repo.owner.toLowerCase().includes(query) ||
        repo.fullName.toLowerCase().includes(query)
    );
  }, [repos, repoSearchQuery]);
  const flatModelOptions = useMemo(
    () => modelOptions.flatMap((group) => group.models),
    [modelOptions]
  );

  useEffect(() => {
    if (!repoDropdownOpen) {
      setActiveRepoIndex(-1);
      return;
    }

    const selectedIndex = filteredRepos.findIndex((repo) => repo.fullName === selectedRepo);
    if (selectedIndex >= 0) {
      setActiveRepoIndex(selectedIndex);
    } else {
      setActiveRepoIndex(filteredRepos.length > 0 ? 0 : -1);
    }
  }, [repoDropdownOpen, filteredRepos, selectedRepo]);

  useEffect(() => {
    if (!modelDropdownOpen) {
      setActiveModelIndex(-1);
      return;
    }

    const selectedIndex = flatModelOptions.findIndex((model) => model.id === selectedModel);
    if (selectedIndex >= 0) {
      setActiveModelIndex(selectedIndex);
    } else {
      setActiveModelIndex(flatModelOptions.length > 0 ? 0 : -1);
    }

    const id = requestAnimationFrame(() => modelListRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [modelDropdownOpen, flatModelOptions, selectedModel]);

  useEffect(() => {
    if (activeRepoIndex >= 0) {
      document
        .getElementById(`${repoListboxId}-option-${activeRepoIndex}`)
        ?.scrollIntoView({ block: "nearest" });
    }
    if (activeModelIndex >= 0) {
      document
        .getElementById(`${modelListboxId}-option-${activeModelIndex}`)
        ?.scrollIntoView({ block: "nearest" });
    }
  }, [activeRepoIndex, activeModelIndex, repoListboxId, modelListboxId]);

  function selectRepo(repoFullName: string): void {
    setSelectedRepo(repoFullName);
    setRepoDropdownOpen(false);
    requestAnimationFrame(() => repoButtonRef.current?.focus());
  }

  function selectModel(modelId: string): void {
    setSelectedModel(modelId);
    setModelDropdownOpen(false);
    requestAnimationFrame(() => modelButtonRef.current?.focus());
  }

  function moveActiveRepoIndex(direction: 1 | -1): void {
    if (filteredRepos.length === 0) return;
    setActiveRepoIndex((currentIndex) => {
      if (currentIndex < 0) {
        return direction === 1 ? 0 : filteredRepos.length - 1;
      }
      return (currentIndex + direction + filteredRepos.length) % filteredRepos.length;
    });
  }

  function moveActiveModelIndex(direction: 1 | -1): void {
    if (flatModelOptions.length === 0) return;
    setActiveModelIndex((currentIndex) => {
      if (currentIndex < 0) {
        return direction === 1 ? 0 : flatModelOptions.length - 1;
      }
      return (currentIndex + direction + flatModelOptions.length) % flatModelOptions.length;
    });
  }

  function handleRepoSearchKeyDown(e: React.KeyboardEvent): void {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveActiveRepoIndex(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveActiveRepoIndex(-1);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActiveRepoIndex(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActiveRepoIndex(filteredRepos.length - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const activeRepo = filteredRepos[activeRepoIndex];
      if (activeRepo) {
        selectRepo(activeRepo.fullName);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      setRepoDropdownOpen(false);
      repoButtonRef.current?.focus();
    }
  }

  function handleModelListKeyDown(e: React.KeyboardEvent): void {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveActiveModelIndex(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveActiveModelIndex(-1);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActiveModelIndex(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActiveModelIndex(flatModelOptions.length - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const activeModel = flatModelOptions[activeModelIndex];
      if (activeModel) {
        selectModel(activeModel.id);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      setModelDropdownOpen(false);
      modelButtonRef.current?.focus();
    }
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header with toggle when sidebar is closed */}
      {!isOpen && (
        <header className="border-b border-border-muted flex-shrink-0">
          <div className="px-4 py-3">
            <button
              onClick={toggle}
              className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition"
              title={`Open sidebar (${SHORTCUT_LABELS.TOGGLE_SIDEBAR})`}
              aria-label={`Open sidebar (${SHORTCUT_LABELS.TOGGLE_SIDEBAR})`}
            >
              <SidebarToggleIcon />
            </button>
          </div>
        </header>
      )}

      <div className="flex-1 flex flex-col items-center justify-center p-8">
        <div className="w-full max-w-2xl">
          {/* Welcome text */}
          <div className="text-center mb-8">
            <h1 className="text-3xl font-semibold text-foreground mb-2">Welcome to Open-Inspect</h1>
            {isAuthenticated ? (
              <p className="text-muted-foreground">
                Ask a question or describe what you want to build
              </p>
            ) : (
              <p className="text-muted-foreground">Sign in to start a new session</p>
            )}
          </div>

          {/* Input box - only show when authenticated */}
          {isAuthenticated && (
            <form onSubmit={handleSubmit}>
              {error && (
                <div className="mb-4 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 px-4 py-3 border border-red-200 dark:border-red-800 text-sm">
                  {error}
                </div>
              )}

              <div className="border border-border bg-input">
                {/* Text input area */}
                <div className="relative">
                  <textarea
                    ref={inputRef}
                    value={prompt}
                    onChange={(e) => handlePromptChange(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="What do you want to build?"
                    disabled={creating}
                    className="w-full resize-none bg-transparent px-4 pt-4 pb-12 focus:outline-none text-foreground placeholder:text-secondary-foreground disabled:opacity-50"
                    rows={3}
                  />
                  {/* Submit button */}
                  <div className="absolute bottom-3 right-3 flex items-center gap-2">
                    {isCreatingSession && (
                      <span className="text-xs text-accent">Warming sandbox...</span>
                    )}
                    <button
                      type="submit"
                      disabled={!prompt.trim() || creating || !selectedRepo}
                      className="p-2 text-secondary-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition"
                      title={`Send (${SHORTCUT_LABELS.SEND_PROMPT})`}
                      aria-label={`Send (${SHORTCUT_LABELS.SEND_PROMPT})`}
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
                    </button>
                  </div>
                </div>

                {/* Footer row with repo and model selectors */}
                <div className="flex flex-col gap-2 px-4 py-2 border-t border-border-muted sm:flex-row sm:items-center sm:justify-between sm:gap-0">
                  {/* Left side - Repo selector + Model selector */}
                  <div className="flex flex-wrap items-center gap-2 sm:gap-4 min-w-0">
                    {/* Repo selector */}
                    <div className="relative min-w-0" ref={repoDropdownRef}>
                      <button
                        ref={repoButtonRef}
                        type="button"
                        onClick={() => !creating && setRepoDropdownOpen(!repoDropdownOpen)}
                        onKeyDown={(e) => {
                          if (creating || loadingRepos) return;
                          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                            e.preventDefault();
                            setRepoDropdownOpen(true);
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            setRepoDropdownOpen(false);
                          }
                        }}
                        disabled={creating || loadingRepos}
                        aria-haspopup="listbox"
                        aria-expanded={repoDropdownOpen}
                        aria-controls={repoDropdownOpen ? repoListboxId : undefined}
                        className="flex max-w-full items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed transition"
                      >
                        <RepoIcon />
                        <span className="truncate max-w-[12rem] sm:max-w-none">
                          {loadingRepos ? "Loading..." : displayRepoName}
                        </span>
                        <ChevronIcon />
                      </button>

                      {repoDropdownOpen && repos.length > 0 && (
                        <div className="absolute bottom-full left-0 mb-2 w-72 bg-background shadow-lg border border-border z-50">
                          <div className="p-2 border-b border-border-muted">
                            <input
                              ref={repoSearchInputRef}
                              type="text"
                              role="combobox"
                              aria-autocomplete="list"
                              aria-label="Search repositories"
                              value={repoSearchQuery}
                              onChange={(e) => setRepoSearchQuery(e.target.value)}
                              onKeyDown={handleRepoSearchKeyDown}
                              aria-controls={repoListboxId}
                              aria-activedescendant={
                                activeRepoIndex >= 0
                                  ? `${repoListboxId}-option-${activeRepoIndex}`
                                  : undefined
                              }
                              placeholder="Search repositories..."
                              className="w-full px-2 py-1.5 text-sm bg-input border border-border focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent placeholder:text-secondary-foreground text-foreground"
                            />
                          </div>

                          <div
                            id={repoListboxId}
                            role="listbox"
                            aria-label="Repository"
                            className="max-h-56 overflow-y-auto py-1"
                          >
                            {filteredRepos.length === 0 ? (
                              <div className="px-3 py-2 text-sm text-muted-foreground">
                                No repositories match {repoSearchQuery.trim()}
                              </div>
                            ) : (
                              filteredRepos.map((repo, index) => (
                                <button
                                  key={repo.id}
                                  id={`${repoListboxId}-option-${index}`}
                                  type="button"
                                  role="option"
                                  aria-selected={selectedRepo === repo.fullName}
                                  onClick={() => selectRepo(repo.fullName)}
                                  onMouseEnter={() => setActiveRepoIndex(index)}
                                  className={`w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-muted transition ${
                                    activeRepoIndex === index ? "bg-muted text-foreground" : ""
                                  } ${
                                    selectedRepo === repo.fullName
                                      ? "text-foreground"
                                      : "text-muted-foreground"
                                  }`}
                                >
                                  <div className="flex flex-col items-start text-left">
                                    <span className="font-medium truncate max-w-[200px]">
                                      {repo.name}
                                    </span>
                                    <span className="text-xs text-secondary-foreground truncate max-w-[200px]">
                                      {repo.owner}
                                      {repo.private && " • private"}
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

                    {/* Model selector */}
                    <div className="relative min-w-0" ref={modelDropdownRef}>
                      <button
                        ref={modelButtonRef}
                        type="button"
                        onClick={() => !creating && setModelDropdownOpen(!modelDropdownOpen)}
                        onKeyDown={(e) => {
                          if (creating) return;
                          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                            e.preventDefault();
                            setModelDropdownOpen(true);
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            setModelDropdownOpen(false);
                          }
                        }}
                        disabled={creating}
                        aria-haspopup="listbox"
                        aria-expanded={modelDropdownOpen}
                        aria-controls={modelDropdownOpen ? modelListboxId : undefined}
                        className="flex max-w-full items-center gap-1 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed transition"
                      >
                        <ModelIcon />
                        <span className="truncate max-w-[9rem] sm:max-w-none">
                          {formatModelNameLower(selectedModel)}
                        </span>
                      </button>

                      {modelDropdownOpen && (
                        <div
                          id={modelListboxId}
                          ref={modelListRef}
                          role="listbox"
                          tabIndex={-1}
                          aria-label="Model"
                          aria-activedescendant={
                            activeModelIndex >= 0
                              ? `${modelListboxId}-option-${activeModelIndex}`
                              : undefined
                          }
                          onKeyDown={handleModelListKeyDown}
                          className="absolute bottom-full left-0 mb-2 w-56 bg-background shadow-lg border border-border py-1 z-50"
                        >
                          {modelOptions.map((group, groupIdx) => (
                            <div key={group.category}>
                              <div
                                role="presentation"
                                className={`px-3 py-1.5 text-xs font-medium text-secondary-foreground uppercase tracking-wider ${
                                  groupIdx > 0 ? "border-t border-border-muted mt-1" : ""
                                }`}
                              >
                                {group.category}
                              </div>
                              {group.models.map((model) => {
                                const flatIndex = flatModelOptions.indexOf(model);
                                return (
                                  <button
                                    key={model.id}
                                    id={`${modelListboxId}-option-${flatIndex}`}
                                    type="button"
                                    role="option"
                                    aria-selected={selectedModel === model.id}
                                    onClick={() => selectModel(model.id)}
                                    onMouseEnter={() => setActiveModelIndex(flatIndex)}
                                    className={`w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-muted transition ${
                                      activeModelIndex === flatIndex
                                        ? "bg-muted text-foreground"
                                        : ""
                                    } ${
                                      selectedModel === model.id
                                        ? "text-foreground"
                                        : "text-muted-foreground"
                                    }`}
                                  >
                                    <div className="flex flex-col items-start">
                                      <span className="font-medium">{model.name}</span>
                                      <span className="text-xs text-secondary-foreground">
                                        {model.description}
                                      </span>
                                    </div>
                                    {selectedModel === model.id && <CheckIcon />}
                                  </button>
                                );
                              })}
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

                  {/* Right side - Agent label */}
                  <span className="hidden sm:inline text-sm text-muted-foreground">
                    build agent
                  </span>
                </div>
              </div>

              {selectedRepoObj && (
                <div className="mt-3 text-center">
                  <Link
                    href="/settings"
                    className="text-xs text-muted-foreground hover:text-foreground transition"
                  >
                    Manage secrets and settings
                  </Link>
                </div>
              )}

              {repos.length === 0 && !loadingRepos && (
                <p className="mt-3 text-sm text-muted-foreground text-center">
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
    <svg className="w-4 h-4 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
    </svg>
  );
}

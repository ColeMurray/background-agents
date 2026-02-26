"use client";

import { useRouter } from "next/navigation";
import { mutate } from "swr";
import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import { useSidebarContext } from "@/components/sidebar-layout";
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
import { SidebarIcon, RepoIcon, ModelIcon, ChevronDownIcon, SendIcon } from "@/components/ui/icons";
import { Combobox, type ComboboxGroup } from "@/components/ui/combobox";

const LAST_SELECTED_REPO_STORAGE_KEY = "background-agents-last-selected-repo";
const LAST_SELECTED_MODEL_STORAGE_KEY = "background-agents-last-selected-model";
const LAST_SELECTED_REASONING_EFFORT_STORAGE_KEY =
  "background-agents-last-selected-reasoning-effort";

export default function Home() {
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
      const hasLastSelectedRepo = repos.some((repo) => repo.path === lastSelectedRepo);
      const defaultRepo = (hasLastSelectedRepo ? lastSelectedRepo : repos[0].path) ?? repos[0].path;
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
            repoPath: selectedRepo,
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
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;

    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const selectedRepoObj = repos.find((r) => r.path === selectedRepo);
  const displayRepoName = selectedRepoObj ? selectedRepoObj.name : "Select repo";

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
              <SidebarIcon className="w-4 h-4" />
            </button>
          </div>
        </header>
      )}

      <div className="flex-1 flex flex-col items-center justify-center p-8">
        <div className="w-full max-w-2xl">
          {/* Welcome text */}
          <div className="text-center mb-8">
            <h1 className="text-3xl font-semibold text-foreground mb-2">Background Agents</h1>
            <p className="text-muted-foreground">
              Ask a question or describe what you want to build
            </p>
          </div>

          {/* Input box */}
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
                      <SendIcon className="w-5 h-5" />
                    )}
                  </button>
                </div>
              </div>

              {/* Footer row with repo and model selectors */}
              <div className="flex flex-col gap-2 px-4 py-2 border-t border-border-muted sm:flex-row sm:items-center sm:justify-between sm:gap-0">
                {/* Left side - Repo selector + Model selector */}
                <div className="flex flex-wrap items-center gap-2 sm:gap-4 min-w-0">
                  {/* Repo selector */}
                  <Combobox
                    value={selectedRepo}
                    onChange={(value) => setSelectedRepo(value)}
                    items={repos.map((repo) => ({
                      value: repo.path,
                      label: repo.name,
                      description: repo.path,
                    }))}
                    searchable
                    searchPlaceholder="Search repositories..."
                    filterFn={(option, query) =>
                      option.label.toLowerCase().includes(query) ||
                      (option.description?.toLowerCase().includes(query) ?? false)
                    }
                    direction="up"
                    dropdownWidth="w-72"
                    disabled={creating || loadingRepos}
                    triggerClassName="flex max-w-full items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed transition"
                  >
                    <RepoIcon className="w-4 h-4" />
                    <span className="truncate max-w-[12rem] sm:max-w-none">
                      {loadingRepos ? "Loading..." : displayRepoName}
                    </span>
                    <ChevronDownIcon className="w-3 h-3" />
                  </Combobox>

                  {/* Model selector */}
                  <Combobox
                    value={selectedModel}
                    onChange={(value) => setSelectedModel(value)}
                    items={
                      modelOptions.map((group) => ({
                        category: group.category,
                        options: group.models.map((model) => ({
                          value: model.id,
                          label: model.name,
                          description: model.description,
                        })),
                      })) as ComboboxGroup[]
                    }
                    direction="up"
                    dropdownWidth="w-56"
                    disabled={creating}
                    triggerClassName="flex max-w-full items-center gap-1 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed transition"
                  >
                    <ModelIcon className="w-3.5 h-3.5" />
                    <span className="truncate max-w-[9rem] sm:max-w-none">
                      {formatModelNameLower(selectedModel)}
                    </span>
                  </Combobox>

                  {/* Reasoning effort pills */}
                  <ReasoningEffortPills
                    selectedModel={selectedModel}
                    reasoningEffort={reasoningEffort}
                    onSelect={setReasoningEffort}
                    disabled={creating}
                  />
                </div>

                {/* Right side - Agent label */}
                <span className="hidden sm:inline text-sm text-muted-foreground">build agent</span>
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
                No repositories found. Configure your repos directory in the server settings.
              </p>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}

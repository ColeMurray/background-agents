"use client";

import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import useSWR, { mutate } from "swr";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import Link from "next/link";
import { useSidebarContext } from "@/components/sidebar-layout";
import { formatModelNameLower } from "@/lib/format";
import { formatRelativeTime } from "@/lib/time";
import { SHORTCUT_LABELS } from "@/lib/keyboard-shortcuts";
import { SIDEBAR_SESSIONS_KEY, type SessionListResponse } from "@/lib/session-list";
import { buildSessionHref, type SessionItem } from "@/components/session-sidebar";
import {
  DEFAULT_MODEL,
  getDefaultReasoningEffort,
  isValidReasoningEffort,
  type ModelCategory,
} from "@open-inspect/shared";
import { useEnabledModels } from "@/hooks/use-enabled-models";
import { useRepos, type Repo } from "@/hooks/use-repos";
import { useBranches } from "@/hooks/use-branches";
import { ReasoningEffortPills } from "@/components/reasoning-effort-pills";
import {
  SidebarIcon,
  RepoIcon,
  ModelIcon,
  BranchIcon,
  ChevronDownIcon,
  SendIcon,
  SearchIcon,
} from "@/components/ui/icons";
import { Combobox, type ComboboxGroup } from "@/components/ui/combobox";

const QUICK_ACTIONS: { label: string; prompt: string }[] = [
  {
    label: "Summarize latest changes",
    prompt: "Summarize the latest changes on this branch.",
  },
  {
    label: "Review my latest PR",
    prompt: "Review my most recent pull request and give detailed feedback.",
  },
  {
    label: "Suggest a new feature",
    prompt: "Based on this codebase, suggest a new feature that would add value.",
  },
  {
    label: "Create a task for…",
    prompt: "Create a task for ",
  },
];

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
  const [selectedBranch, setSelectedBranch] = useState<string>("");
  const [prompt, setPrompt] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const sessionCreationPromise = useRef<Promise<string | null> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const pendingConfigRef = useRef<{ repo: string; model: string; branch: string } | null>(null);
  const [hasHydratedModelPreferences, setHasHydratedModelPreferences] = useState(false);
  const { enabledModels, enabledModelOptions } = useEnabledModels();
  const selectedRepoOwner = selectedRepo.split("/")[0] ?? "";
  const selectedRepoName = selectedRepo.split("/")[1] ?? "";
  const { branches, loading: loadingBranches } = useBranches(selectedRepoOwner, selectedRepoName);

  // Auto-select repo when repos load
  useEffect(() => {
    if (repos.length > 0 && !selectedRepo) {
      const lastSelectedRepo = localStorage.getItem(LAST_SELECTED_REPO_STORAGE_KEY);
      const hasLastSelectedRepo = repos.some((repo) => repo.fullName === lastSelectedRepo);
      const defaultRepo =
        (hasLastSelectedRepo ? lastSelectedRepo : repos[0].fullName) ?? repos[0].fullName;
      setSelectedRepo(defaultRepo);
      const repo = repos.find((r) => r.fullName === defaultRepo);
      if (repo) setSelectedBranch(repo.defaultBranch);
    }
  }, [repos, selectedRepo]);

  useEffect(() => {
    if (!selectedRepo) return;
    localStorage.setItem(LAST_SELECTED_REPO_STORAGE_KEY, selectedRepo);
  }, [selectedRepo]);

  useEffect(() => {
    if (enabledModels.length === 0 || hasHydratedModelPreferences) return;

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
    setHasHydratedModelPreferences(true);
  }, [enabledModels, hasHydratedModelPreferences]);

  useEffect(() => {
    if (!hasHydratedModelPreferences) return;
    localStorage.setItem(LAST_SELECTED_MODEL_STORAGE_KEY, selectedModel);

    if (reasoningEffort) {
      localStorage.setItem(LAST_SELECTED_REASONING_EFFORT_STORAGE_KEY, reasoningEffort);
      return;
    }

    localStorage.removeItem(LAST_SELECTED_REASONING_EFFORT_STORAGE_KEY);
  }, [hasHydratedModelPreferences, selectedModel, reasoningEffort]);

  useEffect(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setPendingSessionId(null);
    setIsCreatingSession(false);
    sessionCreationPromise.current = null;
    pendingConfigRef.current = null;
  }, [selectedRepo, selectedModel, selectedBranch]);

  const createSessionForWarming = useCallback(async () => {
    if (pendingSessionId) return pendingSessionId;
    if (sessionCreationPromise.current) return sessionCreationPromise.current;
    if (!selectedRepo) return null;

    setIsCreatingSession(true);
    const [owner, name] = selectedRepo.split("/");
    const currentConfig = { repo: selectedRepo, model: selectedModel, branch: selectedBranch };
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
            branch: selectedBranch || undefined,
          }),
          signal: abortController.signal,
        });

        if (res.ok) {
          const data = await res.json();
          if (
            pendingConfigRef.current?.repo === currentConfig.repo &&
            pendingConfigRef.current?.model === currentConfig.model &&
            pendingConfigRef.current?.branch === currentConfig.branch
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
  }, [selectedRepo, selectedModel, reasoningEffort, selectedBranch, pendingSessionId]);

  // Reset selections when model preferences change (only after hydration)
  useEffect(() => {
    if (!hasHydratedModelPreferences) return;

    if (enabledModels.length > 0 && !enabledModels.includes(selectedModel)) {
      const fallback = enabledModels[0] ?? DEFAULT_MODEL;
      setSelectedModel(fallback);
      setReasoningEffort(getDefaultReasoningEffort(fallback));
      return;
    }

    if (reasoningEffort && !isValidReasoningEffort(selectedModel, reasoningEffort)) {
      setReasoningEffort(getDefaultReasoningEffort(selectedModel));
    }
  }, [hasHydratedModelPreferences, enabledModels, selectedModel, reasoningEffort]);

  const handleRepoChange = useCallback(
    (repoFullName: string) => {
      setSelectedRepo(repoFullName);
      const repo = repos.find((r) => r.fullName === repoFullName);
      if (repo) setSelectedBranch(repo.defaultBranch);
    },
    [repos]
  );

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
        mutate(SIDEBAR_SESSIONS_KEY);
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
      setSelectedRepo={handleRepoChange}
      selectedBranch={selectedBranch}
      setSelectedBranch={setSelectedBranch}
      branches={branches}
      loadingBranches={loadingBranches}
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
  selectedBranch,
  setSelectedBranch,
  branches,
  loadingBranches,
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
  selectedBranch: string;
  setSelectedBranch: (value: string) => void;
  branches: { name: string }[];
  loadingBranches: boolean;
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

  const selectedRepoObj = repos.find((r) => r.fullName === selectedRepo);
  const displayRepoName = selectedRepoObj ? selectedRepoObj.name : "Select repo";

  return (
    <div className="h-full flex flex-col relative overflow-y-auto">
      {/* Soft teal radial gradient background */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-0"
        style={{
          background:
            "radial-gradient(ellipse 90% 60% at 50% 35%, rgba(94, 214, 188, 0.35), rgba(94, 214, 188, 0.12) 45%, transparent 75%)",
        }}
      />

      {/* Header with toggle when sidebar is closed */}
      {!isOpen && (
        <header className="relative z-10 flex-shrink-0">
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

      <div className="relative z-10 flex-1 flex flex-col items-center px-6 pt-24 pb-12">
        <div className="w-full max-w-2xl">
          {/* Input box - only show when authenticated */}
          {isAuthenticated ? (
            <>
              <form onSubmit={handleSubmit}>
                {error && (
                  <div className="mb-4 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 px-4 py-3 border border-red-200 dark:border-red-800 rounded-md text-sm">
                    {error}
                  </div>
                )}

                <div className="rounded-2xl border border-border bg-input shadow-sm overflow-hidden">
                  {/* Text input area */}
                  <div className="relative">
                    <textarea
                      ref={inputRef}
                      value={prompt}
                      onChange={(e) => handlePromptChange(e.target.value)}
                      onKeyDown={handleKeyDown}
                      placeholder="Ask Open-Inspect…"
                      disabled={creating}
                      className="w-full resize-none bg-transparent px-5 pt-5 pb-2 focus:outline-none text-foreground placeholder:text-secondary-foreground disabled:opacity-50"
                      rows={2}
                    />
                  </div>

                  {/* Model + actions row (white area, sits above teal branch bar) */}
                  <div className="flex items-center justify-between gap-2 px-3 pb-3">
                    <div className="flex flex-wrap items-center gap-2 min-w-0">
                      <button
                        type="button"
                        className="flex items-center justify-center w-8 h-8 rounded-full border border-border text-muted-foreground hover:text-foreground hover:bg-muted transition"
                        aria-label="Attach"
                        title="Attach"
                        disabled={creating}
                      >
                        <span className="text-lg leading-none">+</span>
                      </button>

                      {/* Repo selector */}
                      <Combobox
                        value={selectedRepo}
                        onChange={(value) => setSelectedRepo(value)}
                        items={repos.map((repo) => ({
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
                        direction="up"
                        dropdownWidth="w-72"
                        disabled={creating || loadingRepos}
                        triggerClassName="flex max-w-full items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed transition"
                      >
                        <RepoIcon className="w-4 h-4" />
                        <span className="truncate max-w-[10rem] sm:max-w-none">
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
                        <ChevronDownIcon className="w-3 h-3" />
                      </Combobox>

                      {/* Reasoning effort pills */}
                      <ReasoningEffortPills
                        selectedModel={selectedModel}
                        reasoningEffort={reasoningEffort}
                        onSelect={setReasoningEffort}
                        disabled={creating}
                      />
                    </div>

                    <div className="flex items-center gap-2">
                      {isCreatingSession && (
                        <span className="text-xs text-muted-foreground hidden sm:inline">
                          Warming…
                        </span>
                      )}
                      <button
                        type="submit"
                        disabled={!prompt.trim() || creating || !selectedRepo}
                        className="flex items-center justify-center w-8 h-8 rounded-full bg-foreground text-background hover:opacity-90 disabled:opacity-30 disabled:cursor-not-allowed transition"
                        title={`Send (${SHORTCUT_LABELS.SEND_PROMPT})`}
                        aria-label={`Send (${SHORTCUT_LABELS.SEND_PROMPT})`}
                      >
                        {creating ? (
                          <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                        ) : (
                          <SendIcon className="w-4 h-4" />
                        )}
                      </button>
                    </div>
                  </div>

                  {/* Branch bar — teal accent */}
                  <div className="flex items-center justify-between px-4 py-2 bg-[color:var(--brand-teal)] text-white">
                    <Combobox
                      value={selectedBranch}
                      onChange={(value) => setSelectedBranch(value)}
                      items={branches.map((b) => ({
                        value: b.name,
                        label: b.name,
                      }))}
                      searchable
                      searchPlaceholder="Search branches..."
                      filterFn={(option, query) => option.label.toLowerCase().includes(query)}
                      direction="up"
                      dropdownWidth="w-56"
                      disabled={creating || !selectedRepo || loadingBranches}
                      triggerClassName="flex max-w-full items-center gap-1.5 text-sm text-white/95 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed transition"
                    >
                      <BranchIcon className="w-3.5 h-3.5" />
                      <span className="truncate max-w-[12rem] sm:max-w-none font-medium">
                        {loadingBranches ? "Loading..." : selectedBranch || "branch"}
                      </span>
                      <ChevronDownIcon className="w-3 h-3" />
                    </Combobox>

                    <span className="hidden sm:inline text-xs text-white/80">build agent</span>
                  </div>
                </div>

                {/* Quick action buttons */}
                <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                  {QUICK_ACTIONS.map((action) => (
                    <button
                      key={action.label}
                      type="button"
                      onClick={() => {
                        handlePromptChange(action.prompt);
                        inputRef.current?.focus();
                      }}
                      disabled={creating}
                      className="px-3.5 py-1.5 text-sm rounded-full border border-border bg-input text-foreground hover:bg-muted hover:border-border-muted transition disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
                    >
                      {action.label}
                    </button>
                  ))}
                </div>

                {repos.length === 0 && !loadingRepos && (
                  <p className="mt-3 text-sm text-muted-foreground text-center">
                    No repositories found. Make sure you have granted access to your repositories.
                  </p>
                )}
              </form>

              {/* Open threads list */}
              <OpenThreadsList />
            </>
          ) : (
            <div className="text-center mt-24">
              <h1 className="text-3xl font-semibold text-foreground mb-2">
                Welcome to Open-Inspect
              </h1>
              <p className="text-muted-foreground">Sign in to start a new session</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function OpenThreadsList() {
  const { data: authSession } = useSession();
  const { data, isLoading } = useSWR<SessionListResponse>(
    authSession ? SIDEBAR_SESSIONS_KEY : null
  );
  const [query, setQuery] = useState("");

  const openThreads = useMemo(() => {
    const sessions = (data?.sessions ?? []).filter(
      (s) => s.status !== "archived" && s.status !== "completed"
    );
    const q = query.trim().toLowerCase();
    const filtered = q
      ? sessions.filter((s) => {
          const title = s.title?.toLowerCase() ?? "";
          const repo = `${s.repoOwner}/${s.repoName}`.toLowerCase();
          return title.includes(q) || repo.includes(q);
        })
      : sessions;

    return [...filtered]
      .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
      .slice(0, 6);
  }, [data?.sessions, query]);

  if (!authSession) return null;

  return (
    <div className="mt-12">
      <div className="relative mb-3">
        <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search threads…"
          className="w-full rounded-full border border-border bg-input pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring/40 placeholder:text-secondary-foreground"
        />
      </div>

      <div className="rounded-xl border border-border bg-input overflow-hidden shadow-sm">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border-muted">
          <span className="w-2.5 h-2.5 rounded-full bg-[color:var(--brand-teal)]" aria-hidden />
          <span className="text-sm font-medium text-foreground">Open threads</span>
          <span className="text-xs text-muted-foreground">{openThreads.length}</span>
        </div>

        {isLoading ? (
          <div className="px-4 py-6 text-sm text-muted-foreground text-center">Loading…</div>
        ) : openThreads.length === 0 ? (
          <div className="px-4 py-6 text-sm text-muted-foreground text-center">
            No open threads yet. Send a prompt above to start one.
          </div>
        ) : (
          <ul className="divide-y divide-border-muted">
            {openThreads.map((s) => (
              <li key={s.id}>
                <ThreadListItem session={s} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ThreadListItem({ session }: { session: SessionItem }) {
  const title = session.title || `${session.repoOwner}/${session.repoName}`;
  const initial = (session.repoOwner?.[0] ?? "A").toUpperCase();
  const timestamp = session.updatedAt || session.createdAt;
  return (
    <Link
      href={buildSessionHref(session)}
      className="flex items-start gap-3 px-4 py-3 hover:bg-muted/60 transition"
    >
      <span
        className="flex-shrink-0 w-6 h-6 rounded-md bg-[color:var(--brand-teal)] text-white text-xs font-semibold flex items-center justify-center mt-0.5"
        aria-hidden
      >
        {initial}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium text-foreground">{title}</span>
          <span className="flex-shrink-0 text-xs text-muted-foreground">
            {formatRelativeTime(timestamp)}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="inline-flex items-center px-1.5 py-0.5 rounded-md bg-muted text-muted-foreground font-mono">
            {session.repoName}
          </span>
          {session.baseBranch && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-muted text-muted-foreground">
              <BranchIcon className="w-3 h-3" />
              {session.baseBranch}
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}

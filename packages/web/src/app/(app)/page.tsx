"use client";

import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { mutate } from "swr";
import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import Link from "next/link";
import { useSidebarContext } from "@/components/sidebar-layout";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/error-banner";
import { formatModelNameLower } from "@/lib/format";
import { SHORTCUT_LABELS } from "@/lib/keyboard-shortcuts";
import { NO_REPOSITORY_LABEL } from "@/lib/repo-label";
import { isUnarchivedSessionListKey } from "@/lib/session-list";
import { APP_NAME } from "@/lib/site-config";
import {
  DEFAULT_MODEL,
  getDefaultReasoningEffort,
  isValidReasoningEffort,
  type Environment,
  type ModelCategory,
} from "@open-inspect/shared";
import useSWR from "swr";
import { useEnabledModels } from "@/hooks/use-enabled-models";
import { useRepos, type Repo } from "@/hooks/use-repos";
import { useBranches } from "@/hooks/use-branches";
import { useEnvironments } from "@/hooks/use-environments";
import { supportsRepoImages } from "@/lib/sandbox-provider";
import {
  type SessionTarget,
  NO_REPOSITORY_OPTION_VALUE,
  MULTIPLE_REPOSITORIES_OPTION_VALUE,
  buildSessionTargetRequestFields,
  environmentOptionValue,
  getTargetConfigKey,
  getTargetSelectValue,
  isSessionTargetLaunchable,
  parseRepoFullName,
  parseTargetSelectValue,
} from "@/lib/session-target";
import { RepositoryMultiSelect } from "@/components/repository-multi-select";
import { ReasoningEffortPills } from "@/components/reasoning-effort-pills";
import {
  SidebarIcon,
  RepoIcon,
  ModelIcon,
  BranchIcon,
  ChevronDownIcon,
  SendIcon,
} from "@/components/ui/icons";
import { Combobox, type ComboboxGroup } from "@/components/ui/combobox";

const LAST_SELECTED_REPO_STORAGE_KEY = "open-inspect-last-selected-repo";
const LAST_SELECTED_MODEL_STORAGE_KEY = "open-inspect-last-selected-model";
const LAST_SELECTED_REASONING_EFFORT_STORAGE_KEY = "open-inspect-last-selected-reasoning-effort";

interface EnvironmentImageStatusRow {
  environment_id: string;
  status: "building" | "ready" | "failed";
}

/** Picker subtitle for an environment: repository count plus prebuild state. */
function describeEnvironment(
  environment: Environment,
  imageStatusByEnvironment: Map<string, EnvironmentImageStatusRow["status"]>
): string {
  const count = environment.repositories.length;
  const base = `${count} ${count === 1 ? "repository" : "repositories"}`;
  if (!environment.prebuildEnabled) return base;
  const status = imageStatusByEnvironment.get(environment.id);
  if (status === "ready") return `${base} · prebuilt`;
  if (status === "building") return `${base} · prebuild building`;
  return `${base} · prebuilds on`;
}

export default function Home() {
  const { data: session } = useSession();
  const router = useRouter();
  const { repos, loading: loadingRepos } = useRepos();
  const { environments } = useEnvironments();
  const [sessionTarget, setSessionTarget] = useState<SessionTarget | null>(null);
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
  // Keyed by getTargetConfigKey so environment/ad-hoc selections invalidate
  // a warmed session exactly like repo/branch changes do.
  const pendingConfigRef = useRef<{ target: string; model: string; branch: string } | null>(null);
  const [hasHydratedModelPreferences, setHasHydratedModelPreferences] = useState(false);
  const { enabledModels, enabledModelOptions } = useEnabledModels();
  const targetSelectValue = getTargetSelectValue(sessionTarget);
  const selectedRepository =
    sessionTarget?.kind === "repo" ? parseRepoFullName(sessionTarget.repoFullName) : null;
  const selectedRepoOwner = selectedRepository?.owner ?? "";
  const selectedRepoName = selectedRepository?.name ?? "";
  const { branches, loading: loadingBranches } = useBranches(selectedRepoOwner, selectedRepoName);

  // Prebuild status for the environment options (ready/building rows of
  // prebuild-enabled environments, one call across all of them).
  const { data: environmentImagesData } = useSWR<{ images: EnvironmentImageStatusRow[] }>(
    environments.length > 0 && supportsRepoImages() ? "/api/environment-images" : null
  );
  const imageStatusByEnvironment = useMemo(() => {
    const statusByEnvironment = new Map<string, EnvironmentImageStatusRow["status"]>();
    for (const row of environmentImagesData?.images ?? []) {
      if (row.status === "ready" || !statusByEnvironment.has(row.environment_id)) {
        statusByEnvironment.set(row.environment_id, row.status);
      }
    }
    return statusByEnvironment;
  }, [environmentImagesData]);

  // Auto-select repo when repos load
  useEffect(() => {
    if (sessionTarget) return;

    if (repos.length > 0) {
      const lastSelectedRepo = localStorage.getItem(LAST_SELECTED_REPO_STORAGE_KEY);
      const hasLastSelectedRepo = repos.some((repo) => repo.fullName === lastSelectedRepo);
      const defaultRepo =
        (hasLastSelectedRepo ? lastSelectedRepo : repos[0].fullName) ?? repos[0].fullName;
      setSessionTarget({ kind: "repo", repoFullName: defaultRepo });
      const repo = repos.find((r) => r.fullName === defaultRepo);
      if (repo) setSelectedBranch(repo.defaultBranch);
      return;
    }

    if (!loadingRepos) {
      setSessionTarget({ kind: "none" });
    }
  }, [loadingRepos, repos, sessionTarget]);

  useEffect(() => {
    if (sessionTarget?.kind !== "repo") return;
    localStorage.setItem(LAST_SELECTED_REPO_STORAGE_KEY, sessionTarget.repoFullName);
  }, [sessionTarget]);

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
  }, [sessionTarget, selectedModel, selectedBranch]);

  const createSessionForWarming = useCallback(async () => {
    if (pendingSessionId) return pendingSessionId;
    if (sessionCreationPromise.current) return sessionCreationPromise.current;
    if (!sessionTarget || !isSessionTargetLaunchable(sessionTarget)) return null;

    setIsCreatingSession(true);
    const currentConfig = {
      target: getTargetConfigKey(sessionTarget),
      model: selectedModel,
      branch: sessionTarget.kind === "repo" ? selectedBranch : "",
    };
    pendingConfigRef.current = currentConfig;

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    const promise = (async () => {
      try {
        const res = await fetch("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...buildSessionTargetRequestFields(sessionTarget, selectedBranch),
            model: selectedModel,
            reasoningEffort,
          }),
          signal: abortController.signal,
        });

        if (res.ok) {
          const data = await res.json();
          if (
            pendingConfigRef.current?.target === currentConfig.target &&
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
  }, [sessionTarget, selectedModel, reasoningEffort, selectedBranch, pendingSessionId]);

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

  const handleSessionTargetChange = useCallback(
    (value: string) => {
      const nextTarget = parseTargetSelectValue(value, sessionTarget);
      setSessionTarget(nextTarget);
      if (nextTarget.kind !== "repo") {
        setSelectedBranch("");
        return;
      }
      const repo = repos.find((r) => r.fullName === nextTarget.repoFullName);
      if (repo) setSelectedBranch(repo.defaultBranch);
    },
    [repos, sessionTarget]
  );

  const handleMultiSelectionChange = useCallback((repoFullNames: string[]) => {
    setSessionTarget({ kind: "repos", repoFullNames });
  }, []);

  const handleModelChange = useCallback((model: string) => {
    setSelectedModel(model);
    setReasoningEffort(getDefaultReasoningEffort(model));
  }, []);

  const handlePromptChange = (value: string) => {
    const wasEmpty = prompt.length === 0;
    setPrompt(value);
    if (
      wasEmpty &&
      value.length > 0 &&
      !pendingSessionId &&
      !isCreatingSession &&
      isSessionTargetLaunchable(sessionTarget)
    ) {
      createSessionForWarming();
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim()) return;
    if (!isSessionTargetLaunchable(sessionTarget)) {
      setError(
        sessionTarget?.kind === "repos"
          ? "Select at least one repository"
          : "Please select a repository or environment"
      );
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
        mutate(isUnarchivedSessionListKey);
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
      environments={environments}
      imageStatusByEnvironment={imageStatusByEnvironment}
      sessionTarget={sessionTarget}
      targetSelectValue={targetSelectValue}
      setSessionTargetSelectValue={handleSessionTargetChange}
      onMultiSelectionChange={handleMultiSelectionChange}
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
  environments,
  imageStatusByEnvironment,
  sessionTarget,
  targetSelectValue,
  setSessionTargetSelectValue,
  onMultiSelectionChange,
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
  environments: Environment[];
  imageStatusByEnvironment: Map<string, EnvironmentImageStatusRow["status"]>;
  sessionTarget: SessionTarget | null;
  targetSelectValue: string;
  setSessionTargetSelectValue: (value: string) => void;
  onMultiSelectionChange: (repoFullNames: string[]) => void;
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

  const selectedRepoObj =
    sessionTarget?.kind === "repo"
      ? repos.find((r) => r.fullName === sessionTarget.repoFullName)
      : undefined;
  const selectedEnvironment =
    sessionTarget?.kind === "environment"
      ? environments.find((environment) => environment.id === sessionTarget.environmentId)
      : undefined;
  const displayTargetName = (() => {
    switch (sessionTarget?.kind) {
      case "none":
        return NO_REPOSITORY_LABEL;
      case "repo":
        return selectedRepoObj?.name ?? sessionTarget.repoFullName;
      case "environment":
        return selectedEnvironment?.name ?? "Environment";
      case "repos": {
        const count = sessionTarget.repoFullNames.length;
        if (count === 0) return "Select repositories";
        return `${count} ${count === 1 ? "repository" : "repositories"}`;
      }
      default:
        return "Select repo";
    }
  })();
  const repositoryOptions = [
    {
      value: NO_REPOSITORY_OPTION_VALUE,
      label: NO_REPOSITORY_LABEL,
      description: "Start without cloning a repository",
    },
    {
      value: MULTIPLE_REPOSITORIES_OPTION_VALUE,
      label: "Multiple repositories",
      description: "Pick an ad-hoc set of repositories",
    },
    ...repos.map((repo) => ({
      value: repo.fullName,
      label: repo.name,
      description: `${repo.owner}${repo.private ? " \u2022 private" : ""}`,
    })),
  ];
  // One unified list: environments (when any exist) alongside the repositories.
  const targetOptions =
    environments.length > 0
      ? [
          {
            category: "Environments",
            options: environments.map((environment) => ({
              value: environmentOptionValue(environment.id),
              label: environment.name,
              description: describeEnvironment(environment, imageStatusByEnvironment),
            })),
          },
          { category: "Repositories", options: repositoryOptions },
        ]
      : repositoryOptions;

  return (
    <div className="h-full flex flex-col">
      {/* Header with toggle when sidebar is closed */}
      {!isOpen && (
        <header className="border-b border-border-muted flex-shrink-0">
          <div className="px-4 py-3">
            <Button
              variant="ghost"
              size="icon"
              onClick={toggle}
              title={`Open sidebar (${SHORTCUT_LABELS.TOGGLE_SIDEBAR})`}
              aria-label={`Open sidebar (${SHORTCUT_LABELS.TOGGLE_SIDEBAR})`}
            >
              <SidebarIcon className="w-4 h-4" />
            </Button>
          </div>
        </header>
      )}

      <div className="flex-1 flex flex-col items-center justify-center p-8">
        <div className="w-full max-w-2xl">
          {/* Welcome text */}
          <div className="text-center mb-8">
            <h1 className="text-3xl font-semibold text-foreground mb-2">Welcome to {APP_NAME}</h1>
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
              {error && <ErrorBanner className="mb-4">{error}</ErrorBanner>}

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
                      disabled={
                        !prompt.trim() || creating || !isSessionTargetLaunchable(sessionTarget)
                      }
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
                      value={targetSelectValue}
                      onChange={(value) => setSessionTargetSelectValue(value)}
                      items={targetOptions}
                      searchable
                      searchPlaceholder="Search environments and repositories..."
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
                      <span className="truncate max-w-[12rem] sm:max-w-none">
                        {loadingRepos ? "Loading..." : displayTargetName}
                      </span>
                      <ChevronDownIcon className="w-3 h-3" />
                    </Combobox>

                    {/* Ad-hoc repository set editor */}
                    {sessionTarget?.kind === "repos" && (
                      <RepositoryMultiSelect
                        repos={repos}
                        loadingRepos={loadingRepos}
                        selected={sessionTarget.repoFullNames}
                        onChange={onMultiSelectionChange}
                        disabled={creating || loadingRepos}
                        triggerLabel={
                          sessionTarget.repoFullNames.length === 0
                            ? "Choose repositories"
                            : sessionTarget.repoFullNames.join(", ")
                        }
                        triggerClassName="max-w-[16rem] border-0 bg-transparent px-0 py-0 text-sm text-muted-foreground hover:text-foreground"
                      />
                    )}

                    {/* Branch selector */}
                    {sessionTarget?.kind === "repo" && (
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
                        disabled={creating || loadingBranches}
                        triggerClassName="flex max-w-full items-center gap-1 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed transition"
                      >
                        <BranchIcon className="w-3.5 h-3.5" />
                        <span className="truncate max-w-[9rem] sm:max-w-none">
                          {loadingBranches ? "Loading..." : selectedBranch || "branch"}
                        </span>
                        <ChevronDownIcon className="w-3 h-3" />
                      </Combobox>
                    )}

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
                  <span className="hidden sm:inline text-sm text-muted-foreground">
                    build agent
                  </span>
                </div>
              </div>

              {/* Secrets disclosure per launch unit (design §7.4) */}
              {sessionTarget?.kind === "environment" && (
                <p className="mt-3 text-xs text-muted-foreground text-center">
                  Sessions from this environment use global secrets plus the environment&apos;s
                  secrets.
                </p>
              )}
              {sessionTarget?.kind === "repos" && (
                <p className="mt-3 text-xs text-muted-foreground text-center">
                  Ad-hoc sessions use global secrets plus the selected repositories&apos; secrets,
                  and don&apos;t get prebuilt images —{" "}
                  <Link href="/settings?tab=environments" className="text-accent hover:underline">
                    save this set as an environment
                  </Link>
                  .
                </p>
              )}

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
                  No repositories found. You can start without a repository or grant repository
                  access in settings.
                </p>
              )}
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

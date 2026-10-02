"use client";

import { useProjects, projectRequest } from "@/hooks/use-projects";
import useSWR from "swr";
import type { ReactNode } from "react";
import { useAuthSession } from "@/lib/auth-session";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { toast } from "sonner";
import { sessionActionErrorMessage } from "@/lib/session-action-error";
import { useRouter } from "next/navigation";
import { mutate } from "swr";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import Link from "next/link";
import { CollapsedSidebarControls, useSidebarContext } from "@/components/sidebar-layout";
import { ErrorBanner } from "@/components/ui/error-banner";
import { SessionAccessSelector } from "@/components/session-access-selector";
import { matchesShortcut } from "@/lib/keyboard-shortcuts";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { isUnarchivedSessionListKey } from "@/lib/session-list";
import { isSessionInboxKey } from "@/lib/session-inbox-api";
import { APP_NAME } from "@/lib/site-config";
import type { SessionAttachmentReference } from "@open-inspect/shared/types/session-attachments";
import { MAX_WEB_PROMPT_CHARS } from "@open-inspect/shared/types/websocket";
import {
  DEFAULT_MODEL,
  getDefaultReasoningEffort,
  getSubscriptionProviderForModel,
  type ModelCategory,
  type ReasoningEffort,
  type ValidModel,
} from "@open-inspect/shared/models";
import type { ModelPreference } from "@/lib/model-selection";
import {
  DEFAULT_HARNESS,
  getValidHarnessOrDefault,
  reconcileProviderSelectionsForHarness,
  type HarnessId,
} from "@open-inspect/shared/harnesses";
import { resolveHarnessModelSelection } from "@/lib/session-harness";
import { useEnabledModels } from "@/hooks/use-enabled-models";
import { useAttachmentDropZone } from "@/hooks/use-attachment-drop-zone";
import {
  ATTACHMENT_ACCEPT,
  DEFAULT_ATTACHMENT_ONLY_MESSAGE,
  useSessionAttachments,
} from "@/hooks/use-session-attachments";
import { AttachmentPreviewStrip } from "@/components/attachment-preview-strip";
import {
  useSessionTargetPicker,
  type SessionTargetSelection,
} from "@/hooks/use-session-target-picker";
import { SessionTargetPicker } from "@/components/session-target-picker";
import { ModelReasoningSelector } from "@/components/model-reasoning-selector";
import { PaperclipIcon, SendIcon } from "@/components/ui/icons";
import { SessionSkillSelector } from "@/components/session-skill-selector";
import { PromptSkillTextarea } from "@/components/prompt-skill-autocomplete";
import type { SessionSkillSelection } from "@open-inspect/shared/types/skills";
import {
  useSkillResolutionPreview,
  type SkillResolutionPreviewInput,
  type SkillResolutionPreviewResponse,
} from "@/hooks/use-managed-skills";
import type { SessionTargetRequestFields } from "@/lib/session-target";
import type { PromptSkillSuggestionSource } from "@/lib/prompt-skill-completion";
import type {
  ModelProviderSelections,
  ProviderAuthSelection,
  SubscriptionProviderId,
} from "@open-inspect/shared/types/provider-accounts";
import { ProviderAuthControls } from "@/components/provider-auth-controls";
import { useProviderAccounts } from "@/hooks/use-provider-accounts";
import { useWarmDraftSession, type WarmDraftSessionRequest } from "@/hooks/use-warm-draft-session";
import { useCurrentUserAuthorization } from "@/hooks/use-current-user-authorization";
import { useActiveTeam } from "@/hooks/use-active-team";
import type { SessionVisibility } from "@open-inspect/shared/types/teams";
import { resolveComposerAccess, type ComposerAccessDraft } from "@/lib/composer-access";
import {
  buildInteractiveProviderRoutingIdentity,
  parseStoredProviderSelections,
  reconcileProviderSelections,
  setProviderSelection,
} from "@/lib/provider-selection";

const LAST_SELECTED_MODEL_STORAGE_KEY = "open-inspect-last-selected-model";
const LAST_SELECTED_HARNESS_STORAGE_KEY = "open-inspect-last-selected-harness";
const LAST_SELECTED_REASONING_EFFORT_STORAGE_KEY = "open-inspect-last-selected-reasoning-effort";
const LEGACY_PROVIDER_SELECTIONS_STORAGE_KEY = "open-inspect-last-provider-selections";
const LAST_PROVIDER_SELECTIONS_STORAGE_KEY = "open-inspect-last-provider-selections:v1";

function skillPreviewTarget(
  fields: SessionTargetRequestFields | null
): Omit<SkillResolutionPreviewInput, "selection"> | null {
  if (!fields) return null;
  if ("environmentId" in fields) return { environmentId: fields.environmentId };
  if ("repositories" in fields) {
    return {
      repositories: fields.repositories.map((repository) => ({
        ...repository,
        baseBranch: null,
      })),
    };
  }
  return fields.repoOwner && fields.repoName
    ? { repoOwner: fields.repoOwner, repoName: fields.repoName }
    : {};
}

export default function Home() {
  const { data: session } = useAuthSession();
  const { hasPermission } = useCurrentUserAuthorization();
  const canCreateSession = hasPermission("sessions.create");
  const router = useRouter();
  const teamContext = useActiveTeam();
  const { teams, requireTeamOnCreate, loading: loadingTeams, error: teamError } = teamContext;
  const [accessDraft, setAccessDraft] = useState<ComposerAccessDraft | null>(null);
  const { contextKey, teamId, visibility } = resolveComposerAccess(teamContext, accessDraft);
  const [projectId, setProjectId] = useState("");
  const [appliedProjectId, setAppliedProjectId] = useState("");
  const { projects, loading: projectsLoading, hasMore, loadingMore, loadMore } = useProjects();
  const selectedProject = projects.find((project) => project.id === projectId);
  useEffect(() => {
    setProjectId(new URLSearchParams(window.location.search).get("projectId") ?? "");
  }, []);
  const { data: projectPreview, error: projectPreviewError } = useSWR<{ bytes: number }>(
    projectId ? `/api/projects/${projectId}/context/preview` : null,
    projectRequest
  );
  const projectReady =
    !projectId ||
    (!!selectedProject &&
      appliedProjectId === projectId &&
      teamId === selectedProject.ownerTeamId &&
      !!projectPreview &&
      !projectPreviewError);
  const selectedTeam = teams.find((team) => team.id === teamId);
  const teamCreationReady =
    !loadingTeams && !teamError && (teamId === null ? !requireTeamOnCreate : !!selectedTeam);
  const picker = useSessionTargetPicker({
    teamId,
    defaultEnvironmentId: selectedTeam?.defaultEnvironmentId,
  });
  const { sessionTarget, buildRequestFields, isLaunchable } = picker;
  useEffect(() => {
    if (!projectId) {
      setAppliedProjectId("");
      return;
    }
    if (!selectedProject || appliedProjectId === projectId) return;
    if (teamId !== selectedProject.ownerTeamId) {
      setAccessDraft({
        contextKey,
        teamId: selectedProject.ownerTeamId,
        visibility: selectedProject.ownerTeamId ? "team" : "workspace",
      });
      return;
    }
    if (picker.loadingRepos) return;
    const target = selectedProject.defaultEnvironmentId
      ? `env:${selectedProject.defaultEnvironmentId}`
      : selectedProject.defaultRepoOwner && selectedProject.defaultRepoName
        ? `${selectedProject.defaultRepoOwner}/${selectedProject.defaultRepoName}`
        : "__no_repository__";
    picker.pickerProps.onTargetSelectValueChange(target);
    setAppliedProjectId(projectId);
  }, [
    projectId,
    selectedProject,
    appliedProjectId,
    teamId,
    contextKey,
    picker.loadingRepos,
    picker.pickerProps,
  ]);

  // Composer context changes preserve the audience; sidebar changes use team defaults.
  useEffect(() => {
    if (teamContext.loading || teamContext.error) return;
    setAccessDraft((draft) => (draft ? resolveComposerAccess(teamContext, draft) : null));
  }, [teamContext]);
  const [storedPreference, setStoredPreference] = useState<ModelPreference>({
    model: DEFAULT_MODEL,
    reasoningEffort: getDefaultReasoningEffort(DEFAULT_MODEL),
  });
  const [modelPreferenceDraft, setModelPreferenceDraft] = useState<ModelPreference | null>(null);
  const [harness, setHarness] = useState<HarnessId>(DEFAULT_HARNESS);
  const [prompt, setPrompt] = useState("");
  const [warmRequested, setWarmRequested] = useState(false);
  const [skillSelection, setSkillSelection] = useState<SessionSkillSelection>({ mode: "all" });
  const [providerSelections, setProviderSelections] = useState<ModelProviderSelections>({});
  const [providerSelectionsHydrated, setProviderSelectionsHydrated] = useState(false);
  const providerAccounts = useProviderAccounts();
  const sessionAttachments = useSessionAttachments();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const submitInFlightRef = useRef(false);
  const hasHydratedModelPreferencesRef = useRef(false);
  const { enabledModels, enabledModelOptions, loading: loadingEnabledModels } = useEnabledModels();
  const targetRequestFields = buildRequestFields();
  const currentSkillPreviewTarget = session ? skillPreviewTarget(targetRequestFields) : null;
  const {
    preview: skillPreview,
    loading: skillPreviewLoading,
    suggestions: skillSuggestions,
  } = useSkillResolutionPreview(currentSkillPreviewTarget, skillSelection);

  useEffect(() => {
    if (hasHydratedModelPreferencesRef.current) return;

    const storedModel = localStorage.getItem(LAST_SELECTED_MODEL_STORAGE_KEY);
    const storedReasoningEffort = localStorage.getItem(LAST_SELECTED_REASONING_EFFORT_STORAGE_KEY);
    const storedProviderSelectionsValue = localStorage.getItem(
      LAST_PROVIDER_SELECTIONS_STORAGE_KEY
    );
    const legacyProviderSelectionsValue =
      storedProviderSelectionsValue === null
        ? localStorage.getItem(LEGACY_PROVIDER_SELECTIONS_STORAGE_KEY)
        : null;
    const storedProviderSelections = parseStoredProviderSelections(
      storedProviderSelectionsValue ?? legacyProviderSelectionsValue
    );
    if (legacyProviderSelectionsValue !== null) {
      try {
        if (storedProviderSelections) {
          localStorage.setItem(
            LAST_PROVIDER_SELECTIONS_STORAGE_KEY,
            JSON.stringify(storedProviderSelections)
          );
        }
        localStorage.removeItem(LEGACY_PROVIDER_SELECTIONS_STORAGE_KEY);
      } catch {
        // Storage migration must not block provider-selection hydration.
      }
    }
    setStoredPreference({
      model: storedModel ?? DEFAULT_MODEL,
      reasoningEffort: storedReasoningEffort ?? undefined,
    });
    setHarness(getValidHarnessOrDefault(localStorage.getItem(LAST_SELECTED_HARNESS_STORAGE_KEY)));
    if (storedProviderSelections) setProviderSelections(storedProviderSelections);
    setProviderSelectionsHydrated(true);
    hasHydratedModelPreferencesRef.current = true;
  }, []);

  // Selections both the account list and the harness can honour. The effect
  // below persists any change, so a pin the harness cannot use stays dropped.
  const availableProviderSelections = reconcileProviderSelectionsForHarness(
    harness,
    providerAccounts.loading
      ? providerSelections
      : reconcileProviderSelections(providerSelections, providerAccounts.accounts)
  );

  useEffect(() => {
    if (
      !providerSelectionsHydrated ||
      providerAccounts.loading ||
      availableProviderSelections === providerSelections
    ) {
      return;
    }

    setProviderSelections(availableProviderSelections);
    localStorage.setItem(
      LAST_PROVIDER_SELECTIONS_STORAGE_KEY,
      JSON.stringify(availableProviderSelections)
    );
  }, [
    availableProviderSelections,
    providerAccounts.loading,
    providerSelections,
    providerSelectionsHydrated,
  ]);

  // The harness fixes which enabled models can be picked; a stored or drafted
  // model the harness cannot run resolves to a compatible one instead.
  const modelSelection = useMemo(
    () =>
      resolveHarnessModelSelection({
        harness,
        preference: modelPreferenceDraft ?? storedPreference,
        enabledModels,
        enabledModelOptions,
        loading: loadingEnabledModels,
      }),
    [
      enabledModelOptions,
      enabledModels,
      harness,
      loadingEnabledModels,
      modelPreferenceDraft,
      storedPreference,
    ]
  );
  const { model: selectedModel, reasoningEffort } = modelSelection;
  const harnessHasModels = modelSelection.availability.status !== "unavailable";

  const warmRequest: WarmDraftSessionRequest | null =
    canCreateSession &&
    projectReady &&
    teamCreationReady &&
    session &&
    providerSelectionsHydrated &&
    !providerAccounts.loading &&
    !loadingEnabledModels &&
    harnessHasModels &&
    targetRequestFields
      ? {
          ...targetRequestFields,
          projectId: projectId || null,
          harness,
          model: selectedModel,
          reasoningEffort,
          skillSelection,
          providerSelections: availableProviderSelections,
          teamId,
          visibility,
        }
      : null;
  const warmRoutingIdentity = buildInteractiveProviderRoutingIdentity(
    availableProviderSelections,
    providerAccounts.defaults,
    providerAccounts.accounts
  );
  const {
    identity: warmIdentity,
    sessionId: pendingSessionId,
    isWarming: isCreatingSession,
    warm: createSessionForWarming,
    consume: consumeWarmSession,
    error: creationError,
  } = useWarmDraftSession(warmRequest, warmRoutingIdentity);

  useEffect(() => {
    if (!warmRequested || !warmIdentity) return;
    setWarmRequested(false);
    void createSessionForWarming();
  }, [warmRequested, warmIdentity, createSessionForWarming]);

  const saveModelPreferenceDraft = useCallback((preference: ModelPreference) => {
    setModelPreferenceDraft(preference);
    localStorage.setItem(LAST_SELECTED_MODEL_STORAGE_KEY, preference.model);
    if (preference.reasoningEffort) {
      localStorage.setItem(LAST_SELECTED_REASONING_EFFORT_STORAGE_KEY, preference.reasoningEffort);
    } else {
      localStorage.removeItem(LAST_SELECTED_REASONING_EFFORT_STORAGE_KEY);
    }
  }, []);

  const handleModelChange = useCallback(
    (model: ValidModel) => {
      saveModelPreferenceDraft({ model, reasoningEffort: getDefaultReasoningEffort(model) });
    },
    [saveModelPreferenceDraft]
  );

  const handleReasoningEffortChange = useCallback(
    (nextReasoningEffort: ReasoningEffort | undefined) => {
      saveModelPreferenceDraft({ model: selectedModel, reasoningEffort: nextReasoningEffort });
    },
    [saveModelPreferenceDraft, selectedModel]
  );

  const handleHarnessChange = useCallback((nextHarness: HarnessId) => {
    setHarness(nextHarness);
    localStorage.setItem(LAST_SELECTED_HARNESS_STORAGE_KEY, nextHarness);
  }, []);

  const handleProviderSelectionChange = useCallback(
    (provider: SubscriptionProviderId, selection: ProviderAuthSelection | undefined) => {
      const next = setProviderSelection(availableProviderSelections, provider, selection);
      setProviderSelections(next);
      localStorage.setItem(LAST_PROVIDER_SELECTIONS_STORAGE_KEY, JSON.stringify(next));
    },
    [availableProviderSelections]
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (
      !canCreateSession ||
      !projectReady ||
      !teamCreationReady ||
      creationError?.terminal ||
      submitInFlightRef.current ||
      sessionAttachments.isUploading ||
      !providerSelectionsHydrated ||
      providerAccounts.loading ||
      loadingEnabledModels
    ) {
      return;
    }
    const hasAttachments = sessionAttachments.attachments.length > 0;
    if (!prompt.trim() && !hasAttachments) return;
    if (modelSelection.availability.status === "unavailable") {
      setError(modelSelection.availability.message);
      return;
    }
    if (!isLaunchable) {
      setError(
        sessionTarget?.kind === "repos"
          ? "Select at least one repository"
          : "Please select a repository or environment"
      );
      return;
    }

    submitInFlightRef.current = true;
    setCreating(true);
    setError("");

    try {
      let sessionId = pendingSessionId;
      if (!sessionId) {
        sessionId = await createSessionForWarming();
      }

      if (!sessionId) {
        setError("Failed to create session");
        return;
      }

      let attachments: SessionAttachmentReference[] | undefined;
      if (hasAttachments) {
        try {
          attachments = await sessionAttachments.uploadAll(sessionId);
        } catch {
          return;
        }
      }

      const res = await browserApiFetch(`/api/sessions/${sessionId}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: prompt.trim() || DEFAULT_ATTACHMENT_ONLY_MESSAGE,
          model: selectedModel,
          reasoningEffort,
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
        }),
      });

      if (res.ok) {
        consumeWarmSession(sessionId);
        sessionAttachments.clearAttachments();
        mutate(isUnarchivedSessionListKey);
        mutate(isSessionInboxKey);
        router.push(`/session/${sessionId}`);
      } else {
        if (res.status === 403) {
          const message = await sessionActionErrorMessage(res, "Failed to send prompt");
          toast.error(message);
          setError(message);
        } else {
          const data = await res.json();
          setError(data.error || "Failed to send prompt");
        }
        setCreating(false);
      }
    } catch (_error) {
      setError("Failed to create session");
    } finally {
      submitInFlightRef.current = false;
      setCreating(false);
    }
  };

  return (
    <HomeContent
      isAuthenticated={!!session}
      canCreateSession={canCreateSession}
      projectControl={
        <div className="flex flex-wrap items-center gap-2">
          <label>
            Project{" "}
            <select
              aria-label="Project"
              className="rounded border bg-background p-2"
              value={projectId}
              disabled={projectsLoading}
              onChange={(event) => {
                setAppliedProjectId("");
                setProjectId(event.target.value);
              }}
            >
              <option value="">No project</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          {hasMore && (
            <button type="button" disabled={loadingMore} onClick={() => void loadMore()}>
              Load more projects
            </button>
          )}
          {selectedProject && (
            <span className="rounded border px-2 py-1 text-xs">
              Context: {selectedProject.name} (
              {projectPreview ? `${(projectPreview.bytes / 1000).toFixed(1)} KB` : "loading…"})
            </span>
          )}
          {(projectPreviewError || (projectId && !projectsLoading && !selectedProject)) && (
            <span role="alert">Project unavailable. Select another project or No project.</span>
          )}
        </div>
      }
      picker={picker}
      teamContext={teamContext}
      teamId={teamId}
      projectReady={projectReady}
      teamCreationReady={teamCreationReady}
      visibility={visibility}
      onTeamChange={(teamId) => {
        setProjectId("");
        setAccessDraft({ contextKey, teamId, visibility });
      }}
      onVisibilityChange={(value) => {
        if (teamId !== null || value !== "team")
          setAccessDraft({
            contextKey,
            teamId,
            visibility: value,
          });
      }}
      selectedModel={selectedModel}
      setSelectedModel={handleModelChange}
      reasoningEffort={reasoningEffort}
      setReasoningEffort={handleReasoningEffortChange}
      harness={harness}
      setHarness={handleHarnessChange}
      prompt={prompt}
      handlePromptChange={(value) => {
        setPrompt(value);
        setWarmRequested(value.length > 0);
      }}
      attachments={{
        items: sessionAttachments.attachments,
        error: sessionAttachments.attachmentError,
        isUploading: sessionAttachments.isUploading,
        onAdd: sessionAttachments.addFiles,
        onRemove: sessionAttachments.removeAttachment,
      }}
      creating={creating}
      isCreatingSession={isCreatingSession}
      providerSelectionsHydrated={providerSelectionsHydrated}
      error={creationError?.message ?? error}
      handleSubmit={handleSubmit}
      modelOptions={modelSelection.options}
      skillSelection={skillSelection}
      setSkillSelection={setSkillSelection}
      skillPreviewTarget={currentSkillPreviewTarget}
      skillPreview={skillPreview}
      skillPreviewLoading={skillPreviewLoading}
      skillSuggestions={skillSuggestions}
      providerSelections={availableProviderSelections}
      onProviderSelectionChange={handleProviderSelectionChange}
      providerAccounts={providerAccounts}
    />
  );
}

function HomeContent({
  isAuthenticated,
  canCreateSession,
  projectControl,
  picker,
  teamContext,
  teamId,
  teamCreationReady,
  projectReady,
  visibility,
  onTeamChange,
  onVisibilityChange,
  selectedModel,
  setSelectedModel,
  reasoningEffort,
  setReasoningEffort,
  harness,
  setHarness,
  prompt,
  handlePromptChange,
  attachments,
  creating,
  isCreatingSession,
  providerSelectionsHydrated,
  error,
  handleSubmit,
  modelOptions,
  skillSelection,
  setSkillSelection,
  skillPreviewTarget,
  skillPreview,
  skillPreviewLoading,
  skillSuggestions,
  providerSelections,
  onProviderSelectionChange,
  providerAccounts,
}: {
  isAuthenticated: boolean;
  canCreateSession: boolean;
  projectControl: ReactNode;
  picker: SessionTargetSelection;
  teamContext: ReturnType<typeof useActiveTeam>;
  teamId: string | null;
  teamCreationReady: boolean;
  projectReady: boolean;
  visibility: SessionVisibility;
  onTeamChange: (teamId: string | null) => void;
  onVisibilityChange: (value: SessionVisibility) => void;
  selectedModel: ValidModel;
  setSelectedModel: (value: ValidModel) => void;
  reasoningEffort: ReasoningEffort | undefined;
  setReasoningEffort: (value: ReasoningEffort | undefined) => void;
  harness: HarnessId;
  setHarness: (value: HarnessId) => void;
  prompt: string;
  handlePromptChange: (value: string) => void;
  attachments: {
    items: ReturnType<typeof useSessionAttachments>["attachments"];
    error: string | null;
    isUploading: boolean;
    onAdd: (files: Iterable<File>) => void;
    onRemove: (id: string) => void;
  };
  creating: boolean;
  isCreatingSession: boolean;
  providerSelectionsHydrated: boolean;
  error: string;
  handleSubmit: (e: React.FormEvent) => void;
  modelOptions: ModelCategory[];
  skillSelection: SessionSkillSelection;
  setSkillSelection: (value: SessionSkillSelection) => void;
  skillPreviewTarget: Omit<SkillResolutionPreviewInput, "selection"> | null;
  skillPreview: SkillResolutionPreviewResponse | null;
  skillPreviewLoading: boolean;
  skillSuggestions: PromptSkillSuggestionSource;
  providerSelections: ModelProviderSelections;
  onProviderSelectionChange: (
    provider: SubscriptionProviderId,
    selection: ProviderAuthSelection | undefined
  ) => void;
  providerAccounts: ReturnType<typeof useProviderAccounts>;
}) {
  const { isOpen } = useSidebarContext();
  const { shortcuts, labels } = useKeyboardShortcuts();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachmentsLocked = creating || attachments.isUploading;
  const {
    isDraggingOver,
    handleFileInputChange,
    handlePaste,
    handleDrop,
    handleDragOver,
    handleDragLeave,
  } = useAttachmentDropZone({ locked: attachmentsLocked, onAdd: attachments.onAdd });
  const { sessionTarget, repos, loadingRepos, isLaunchable } = picker;
  const selectedProvider = getSubscriptionProviderForModel(selectedModel);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;

    if (matchesShortcut(e.nativeEvent, shortcuts["send-prompt"])) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header with toggle when sidebar is closed */}
      {!isOpen && (
        <header className="border-b border-border-muted flex-shrink-0">
          <div className="px-4 py-3">
            <CollapsedSidebarControls />
          </div>
        </header>
      )}

      <div className="flex-1 flex flex-col items-center justify-center p-8">
        <div className="w-full max-w-2xl">
          {/* Welcome text */}
          <div className="text-center mb-8">
            <h1 className="text-3xl font-semibold text-foreground mb-2">Welcome to {APP_NAME}</h1>
            {isAuthenticated && canCreateSession ? (
              <p className="text-muted-foreground">
                Ask a question or describe what you want to build
              </p>
            ) : isAuthenticated ? (
              <p className="text-muted-foreground">
                You don&apos;t have permission to create sessions.
              </p>
            ) : (
              <p className="text-muted-foreground">Sign in to start a new session</p>
            )}
          </div>

          {/* Input box - only show when authenticated */}
          {isAuthenticated && canCreateSession && (
            <form onSubmit={handleSubmit}>
              {error && <ErrorBanner className="mb-4">{error}</ErrorBanner>}
              {teamContext.error ? (
                <ErrorBanner className="mb-4">
                  Unable to load team memberships and settings.
                </ErrorBanner>
              ) : !teamContext.loading &&
                teamContext.requireTeamOnCreate &&
                teamContext.teams.length === 0 ? (
                <p role="status" className="mb-4 text-sm text-muted-foreground">
                  Join a team to create a session.
                </p>
              ) : null}

              <div className="mb-3 flex flex-wrap items-center gap-2 px-4 sm:gap-4">
                {projectControl}
                <SessionTargetPicker {...picker.pickerProps} disabled={creating} />
              </div>

              <div
                className={`border border-border bg-input ${isDraggingOver ? "ring-2 ring-accent" : ""}`}
                onPaste={handlePaste}
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
              >
                <AttachmentPreviewStrip
                  items={attachments.items}
                  error={attachments.error}
                  onRemove={attachments.onRemove}
                  disabled={attachmentsLocked}
                />
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={ATTACHMENT_ACCEPT}
                  multiple
                  className="hidden"
                  onChange={handleFileInputChange}
                />
                {/* Text input area */}
                <div className="relative">
                  <PromptSkillTextarea
                    ref={inputRef}
                    value={prompt}
                    suggestions={skillSuggestions}
                    onValueChange={handlePromptChange}
                    onKeyDown={handleKeyDown}
                    maxLength={MAX_WEB_PROMPT_CHARS}
                    disabled={creating}
                    placeholder="What do you want to build?"
                    autoFocus
                    autoComplete="off"
                    className="w-full resize-none bg-transparent px-4 pt-4 pb-12 focus:outline-none text-foreground placeholder:text-secondary-foreground disabled:opacity-50"
                    rows={3}
                  />
                  {/* Submit button */}
                  <div className="absolute bottom-3 right-3 flex items-center gap-2">
                    {isCreatingSession && (
                      <span className="whitespace-nowrap text-xs text-accent">
                        Warming sandbox...
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={attachmentsLocked}
                      className="p-2 text-secondary-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition"
                      title="Attach images"
                      aria-label="Attach images"
                    >
                      <PaperclipIcon className="w-5 h-5" />
                    </button>
                    <button
                      type="submit"
                      disabled={
                        (!prompt.trim() && attachments.items.length === 0) ||
                        attachmentsLocked ||
                        !providerSelectionsHydrated ||
                        providerAccounts.loading ||
                        !isLaunchable ||
                        !teamCreationReady ||
                        !projectReady
                      }
                      className="p-2 text-secondary-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition"
                      title={`Send (${labels["send-prompt"]})`}
                      aria-label={`Send (${labels["send-prompt"]})`}
                    >
                      {creating ? (
                        <div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                      ) : (
                        <SendIcon className="w-5 h-5" />
                      )}
                    </button>
                  </div>
                </div>

                {/* Agent configuration stays inside the composer. */}
                <div className="flex flex-col gap-2 px-4 py-2 border-t border-border-muted sm:flex-row sm:items-center sm:gap-0">
                  <div className="flex flex-wrap items-center gap-2 sm:gap-4 min-w-0">
                    <ModelReasoningSelector
                      selectedModel={selectedModel}
                      reasoningEffort={reasoningEffort}
                      items={modelOptions}
                      onModelChange={setSelectedModel}
                      onReasoningEffortChange={setReasoningEffort}
                      harness={harness}
                      onHarnessChange={setHarness}
                      disabled={creating}
                    />

                    <SessionSkillSelector
                      value={skillSelection}
                      onChange={setSkillSelection}
                      target={skillPreviewTarget}
                      preview={skillPreview}
                      previewLoading={skillPreviewLoading}
                      disabled={creating}
                    />

                    {selectedProvider && (
                      <ProviderAuthControls
                        harness={harness}
                        variant="menu"
                        provider={selectedProvider}
                        accounts={providerAccounts.accounts}
                        defaultValue={providerAccounts.defaults.find(
                          (item) => item.provider === selectedProvider
                        )}
                        value={providerSelections[selectedProvider]}
                        disabled={creating}
                        onChange={(selection) =>
                          onProviderSelectionChange(selectedProvider, selection)
                        }
                      />
                    )}
                  </div>
                </div>
              </div>

              <SessionAccessSelector
                teamId={teamId}
                teams={teamContext.teams}
                visibility={visibility}
                onTeamChange={onTeamChange}
                onVisibilityChange={onVisibilityChange}
                requireTeamOnCreate={teamContext.requireTeamOnCreate}
                disabled={creating || teamContext.loading || !!teamContext.error}
                visibilityDisabled={!teamCreationReady}
              />

              {/* Secrets disclosure per session target (design §7.4) */}
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

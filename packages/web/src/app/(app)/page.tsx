"use client";

import { useAuthSession } from "@/lib/auth-session";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { useRouter } from "next/navigation";
import { mutate } from "swr";
import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import { CollapsedSidebarControls, useSidebarContext } from "@/components/sidebar-layout";
import { ErrorBanner } from "@/components/ui/error-banner";
import { matchesShortcut } from "@/lib/keyboard-shortcuts";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { isUnarchivedSessionListKey } from "@/lib/session-list";
import { isSessionInboxKey } from "@/lib/session-inbox-api";
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
import { resolveModelPreference, type ModelPreference } from "@/lib/model-selection";
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
import {
  buildInteractiveProviderRoutingIdentity,
  parseStoredProviderSelections,
  reconcileProviderSelections,
  setProviderSelection,
} from "@/lib/provider-selection";

const LAST_SELECTED_MODEL_STORAGE_KEY = "open-inspect-last-selected-model";
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
  const router = useRouter();
  const picker = useSessionTargetPicker();
  const { sessionTarget, buildRequestFields, isLaunchable } = picker;
  const [storedPreference, setStoredPreference] = useState<ModelPreference>({
    model: DEFAULT_MODEL,
    reasoningEffort: getDefaultReasoningEffort(DEFAULT_MODEL),
  });
  const [modelPreferenceDraft, setModelPreferenceDraft] = useState<ModelPreference | null>(null);
  const [prompt, setPrompt] = useState("");
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
    if (storedProviderSelections) setProviderSelections(storedProviderSelections);
    setProviderSelectionsHydrated(true);
    hasHydratedModelPreferencesRef.current = true;
  }, []);

  const availableProviderSelections = providerAccounts.loading
    ? providerSelections
    : reconcileProviderSelections(providerSelections, providerAccounts.accounts);

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

  const { model: selectedModel, reasoningEffort } = resolveModelPreference(
    modelPreferenceDraft ?? storedPreference,
    loadingEnabledModels ? undefined : enabledModels
  );

  const warmRequest: WarmDraftSessionRequest | null =
    session &&
    providerSelectionsHydrated &&
    !providerAccounts.loading &&
    !loadingEnabledModels &&
    targetRequestFields
      ? {
          ...targetRequestFields,
          model: selectedModel,
          reasoningEffort,
          skillSelection,
          providerSelections: availableProviderSelections,
        }
      : null;
  const warmRoutingIdentity = buildInteractiveProviderRoutingIdentity(
    availableProviderSelections,
    providerAccounts.defaults,
    providerAccounts.accounts
  );
  const {
    sessionId: pendingSessionId,
    isWarming: isCreatingSession,
    warm: createSessionForWarming,
    consume: consumeWarmSession,
  } = useWarmDraftSession(warmRequest, warmRoutingIdentity);

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

  const handleProviderSelectionChange = useCallback(
    (provider: SubscriptionProviderId, selection: ProviderAuthSelection | undefined) => {
      const next = setProviderSelection(availableProviderSelections, provider, selection);
      setProviderSelections(next);
      localStorage.setItem(LAST_PROVIDER_SELECTIONS_STORAGE_KEY, JSON.stringify(next));
    },
    [availableProviderSelections]
  );

  const handlePromptChange = (value: string) => {
    const wasEmpty = prompt.length === 0;
    setPrompt(value);
    if (
      wasEmpty &&
      value.length > 0 &&
      !pendingSessionId &&
      !isCreatingSession &&
      !loadingEnabledModels &&
      isLaunchable
    ) {
      createSessionForWarming();
    }
  };

  const handleAddFiles = (files: Iterable<File>) => {
    sessionAttachments.addFiles(files);
    if (!pendingSessionId && !isCreatingSession && isLaunchable) {
      createSessionForWarming();
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (
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
        const data = await res.json();
        setError(data.error || "Failed to send prompt");
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
      picker={picker}
      selectedModel={selectedModel}
      setSelectedModel={handleModelChange}
      reasoningEffort={reasoningEffort}
      setReasoningEffort={handleReasoningEffortChange}
      prompt={prompt}
      handlePromptChange={handlePromptChange}
      attachments={{
        items: sessionAttachments.attachments,
        error: sessionAttachments.attachmentError,
        isUploading: sessionAttachments.isUploading,
        onAdd: handleAddFiles,
        onRemove: sessionAttachments.removeAttachment,
      }}
      creating={creating}
      isCreatingSession={isCreatingSession}
      providerSelectionsHydrated={providerSelectionsHydrated}
      error={error}
      handleSubmit={handleSubmit}
      modelOptions={enabledModelOptions}
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
  picker,
  selectedModel,
  setSelectedModel,
  reasoningEffort,
  setReasoningEffort,
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
  picker: SessionTargetSelection;
  selectedModel: ValidModel;
  setSelectedModel: (value: ValidModel) => void;
  reasoningEffort: ReasoningEffort | undefined;
  setReasoningEffort: (value: ReasoningEffort | undefined) => void;
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
  const { sessionTarget, selectedRepo, repos, loadingRepos, isLaunchable } = picker;
  const selectedProvider = getSubscriptionProviderForModel(selectedModel);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;

    if (matchesShortcut(e.nativeEvent, shortcuts["send-prompt"])) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="h-14 flex-shrink-0 border-b border-border-muted">
        <div className="flex h-full items-center gap-3 px-4">
          {!isOpen && <CollapsedSidebarControls />}
          <h1 className="text-sm font-medium text-foreground">New session</h1>
        </div>
      </header>

      <div className="flex flex-1 overflow-y-auto">
        <div className="m-auto w-full max-w-3xl px-4 py-10 sm:px-8 sm:py-16">
          <div className="mb-8 text-center sm:mb-10">
            <h2 className="mb-2 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
              Start with an outcome
            </h2>
            <p className="text-sm text-muted-foreground sm:text-base">
              {isAuthenticated
                ? "What should the agent work on?"
                : "Sign in to start a new session"}
            </p>
          </div>

          {/* Input box - only show when authenticated */}
          {isAuthenticated && (
            <form onSubmit={handleSubmit}>
              {error && <ErrorBanner className="mb-4">{error}</ErrorBanner>}

              <div
                className={`rounded-xl border bg-input shadow-sm transition-shadow ${
                  isDraggingOver
                    ? "border-accent ring-2 ring-accent/30"
                    : "border-border-muted focus-within:border-border"
                }`}
                onPaste={handlePaste}
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
              >
                <div className="flex min-h-12 flex-wrap items-center justify-between gap-2 rounded-t-xl border-b border-border-muted bg-muted/20 px-4 py-2.5">
                  <div className="flex min-w-0 flex-wrap items-center gap-2 sm:gap-4">
                    <SessionTargetPicker {...picker.pickerProps} disabled={creating} />
                  </div>
                  {isCreatingSession && (
                    <span
                      role="status"
                      className="sr-only whitespace-nowrap text-xs text-accent sm:not-sr-only"
                    >
                      Preparing session...
                    </span>
                  )}
                </div>
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
                    autoComplete="off"
                    className="min-h-36 w-full resize-none bg-transparent px-4 py-4 text-foreground placeholder:text-secondary-foreground focus:outline-none disabled:opacity-50 sm:min-h-44"
                    rows={5}
                  />
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border-muted px-3 py-2.5 sm:px-4">
                  <div className="flex min-w-0 flex-wrap items-center gap-2 sm:gap-4">
                    <ModelReasoningSelector
                      selectedModel={selectedModel}
                      reasoningEffort={reasoningEffort}
                      items={modelOptions}
                      onModelChange={setSelectedModel}
                      onReasoningEffortChange={setReasoningEffort}
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
                  <div className="ml-auto flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={attachmentsLocked}
                      className="rounded-md p-2 text-secondary-foreground transition hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
                      title="Attach images"
                      aria-label="Attach images"
                    >
                      <PaperclipIcon className="h-5 w-5" />
                    </button>
                    <button
                      type="submit"
                      disabled={
                        (!prompt.trim() && attachments.items.length === 0) ||
                        attachmentsLocked ||
                        !providerSelectionsHydrated ||
                        providerAccounts.loading ||
                        !isLaunchable
                      }
                      className="rounded-md bg-primary p-2 text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-30"
                      title={`Send (${labels["send-prompt"]})`}
                      aria-label={`Send (${labels["send-prompt"]})`}
                    >
                      {creating ? (
                        <div className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                      ) : (
                        <SendIcon className="h-5 w-5" />
                      )}
                    </button>
                  </div>
                </div>
              </div>

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

              {selectedRepo && (
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

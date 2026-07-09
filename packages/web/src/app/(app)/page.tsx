"use client";

import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { mutate } from "swr";
import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import { useSidebarContext } from "@/components/sidebar-layout";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/error-banner";
import { formatModelNameLower } from "@/lib/format";
import { SHORTCUT_LABELS } from "@/lib/keyboard-shortcuts";
import { isUnarchivedSessionListKey } from "@/lib/session-list";
import { APP_NAME } from "@/lib/site-config";
import {
  DEFAULT_MODEL,
  getDefaultReasoningEffort,
  isValidReasoningEffort,
  type Attachment,
  type ModelCategory,
} from "@open-inspect/shared";
import { useEnabledModels } from "@/hooks/use-enabled-models";
import { useAttachmentDropZone } from "@/hooks/use-attachment-drop-zone";
import {
  usePromptAttachments,
  ATTACHMENT_ACCEPT,
  DEFAULT_ATTACHMENT_ONLY_MESSAGE,
} from "@/hooks/use-prompt-attachments";
import {
  useSessionTargetPicker,
  type SessionTargetSelection,
} from "@/hooks/use-session-target-picker";
import { AttachmentPreviewStrip } from "@/components/attachment-preview-strip";
import { SessionTargetPicker } from "@/components/session-target-picker";
import { ReasoningEffortPills } from "@/components/reasoning-effort-pills";
import { SidebarIcon, ModelIcon, PaperclipIcon, SendIcon } from "@/components/ui/icons";
import { Combobox, type ComboboxGroup } from "@/components/ui/combobox";

const LAST_SELECTED_MODEL_STORAGE_KEY = "open-inspect-last-selected-model";
const LAST_SELECTED_REASONING_EFFORT_STORAGE_KEY = "open-inspect-last-selected-reasoning-effort";

export default function Home() {
  const { data: session } = useSession();
  const router = useRouter();
  const picker = useSessionTargetPicker();
  const { sessionTarget, selectedBranch, configKey, buildRequestFields, isLaunchable } = picker;
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_MODEL);
  const [reasoningEffort, setReasoningEffort] = useState<string | undefined>(
    getDefaultReasoningEffort(DEFAULT_MODEL)
  );
  const [prompt, setPrompt] = useState("");
  const promptAttachments = usePromptAttachments();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  // Synchronous re-entry guard: React state doesn't commit fast enough to
  // stop a double-click or repeated Cmd+Enter from submitting twice while the
  // session create and attachment uploads are awaited.
  const submitInFlightRef = useRef(false);
  const sessionCreationPromise = useRef<Promise<string | null> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  // Keyed by the picker's configKey so environment/ad-hoc selections
  // invalidate a warmed session exactly like repo/branch changes do.
  const pendingConfigRef = useRef<{ target: string; model: string; branch: string } | null>(null);
  const [hasHydratedModelPreferences, setHasHydratedModelPreferences] = useState(false);
  const { enabledModels, enabledModelOptions } = useEnabledModels();

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
    const targetRequestFields = buildRequestFields();
    if (!targetRequestFields) return null;

    setIsCreatingSession(true);
    const currentConfig = {
      target: configKey,
      model: selectedModel,
      branch: sessionTarget?.kind === "repo" ? selectedBranch : "",
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
            ...targetRequestFields,
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
  }, [
    sessionTarget,
    selectedBranch,
    configKey,
    buildRequestFields,
    selectedModel,
    reasoningEffort,
    pendingSessionId,
  ]);

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

  const handleModelChange = useCallback((model: string) => {
    setSelectedModel(model);
    setReasoningEffort(getDefaultReasoningEffort(model));
  }, []);

  const handlePromptChange = (value: string) => {
    const wasEmpty = prompt.length === 0;
    setPrompt(value);
    if (wasEmpty && value.length > 0 && !pendingSessionId && !isCreatingSession && isLaunchable) {
      createSessionForWarming();
    }
  };

  const handleAddFiles = (files: Iterable<File>) => {
    promptAttachments.addFiles(files);
    // Attaching a file signals intent to send just like typing does.
    if (!pendingSessionId && !isCreatingSession && isLaunchable) {
      createSessionForWarming();
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitInFlightRef.current || promptAttachments.isUploading) return;
    const hasAttachments = promptAttachments.attachments.length > 0;
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
        setCreating(false);
        return;
      }

      let attachments: Attachment[] | undefined;
      if (hasAttachments) {
        try {
          attachments = await promptAttachments.uploadAll(sessionId);
        } catch {
          // uploadAll surfaces the error in the composer; keep the draft intact.
          setCreating(false);
          return;
        }
      }

      const trimmed = prompt.trim();
      // Nothing survived to send (e.g. the only attachment failed to upload).
      // Don't post the attachment-only fallback message with no attachments.
      if (!trimmed && (!attachments || attachments.length === 0)) {
        setCreating(false);
        return;
      }

      const res = await fetch(`/api/sessions/${sessionId}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: trimmed || DEFAULT_ATTACHMENT_ONLY_MESSAGE,
          model: selectedModel,
          reasoningEffort,
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
        }),
      });

      if (res.ok) {
        promptAttachments.clearAttachments();
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
    } finally {
      submitInFlightRef.current = false;
    }
  };

  return (
    <HomeContent
      isAuthenticated={!!session}
      picker={picker}
      selectedModel={selectedModel}
      setSelectedModel={handleModelChange}
      reasoningEffort={reasoningEffort}
      setReasoningEffort={setReasoningEffort}
      prompt={prompt}
      handlePromptChange={handlePromptChange}
      attachments={{
        items: promptAttachments.attachments,
        error: promptAttachments.attachmentError,
        isUploading: promptAttachments.isUploading,
        onAdd: handleAddFiles,
        onRemove: promptAttachments.removeAttachment,
      }}
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
  error,
  handleSubmit,
  modelOptions,
}: {
  isAuthenticated: boolean;
  picker: SessionTargetSelection;
  selectedModel: string;
  setSelectedModel: (value: string) => void;
  reasoningEffort: string | undefined;
  setReasoningEffort: (value: string | undefined) => void;
  prompt: string;
  handlePromptChange: (value: string) => void;
  attachments: {
    items: ReturnType<typeof usePromptAttachments>["attachments"];
    error: string | null;
    isUploading: boolean;
    onAdd: (files: Iterable<File>) => void;
    onRemove: (id: string) => void;
  };
  creating: boolean;
  isCreatingSession: boolean;
  error: string;
  handleSubmit: (e: React.FormEvent) => void;
  modelOptions: ModelCategory[];
}) {
  const { isOpen, toggle } = useSidebarContext();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Freeze the draft while a session-create/upload/submit is in flight so the
  // set that gets uploaded and sent can't diverge from what the user submitted.
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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;

    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
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

              <div
                className={`border bg-input ${isDraggingOver ? "border-accent" : "border-border"}`}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
              >
                {/* Pending attachment previews */}
                <AttachmentPreviewStrip
                  items={attachments.items}
                  error={attachments.error}
                  onRemove={attachments.onRemove}
                  disabled={attachmentsLocked}
                />

                {/* Text input area */}
                <div className="relative">
                  <textarea
                    ref={inputRef}
                    value={prompt}
                    onChange={(e) => handlePromptChange(e.target.value)}
                    onKeyDown={handleKeyDown}
                    onPaste={handlePaste}
                    placeholder="What do you want to build?"
                    disabled={creating}
                    className="w-full resize-none bg-transparent px-4 pt-4 pb-12 focus:outline-none text-foreground placeholder:text-secondary-foreground disabled:opacity-50"
                    rows={3}
                  />
                  {/* Submit button */}
                  <div className="absolute bottom-3 right-3 flex items-center gap-2">
                    {attachments.isUploading && (
                      <span className="text-xs text-muted-foreground">Uploading...</span>
                    )}
                    {isCreatingSession && (
                      <span className="text-xs text-accent">Warming sandbox...</span>
                    )}
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept={ATTACHMENT_ACCEPT}
                      multiple
                      className="hidden"
                      onChange={handleFileInputChange}
                    />
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={attachmentsLocked}
                      className="p-2 text-secondary-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition"
                      title="Attach images or videos"
                      aria-label="Attach images or videos"
                    >
                      <PaperclipIcon className="w-5 h-5" />
                    </button>
                    <button
                      type="submit"
                      disabled={
                        (!prompt.trim() && attachments.items.length === 0) ||
                        creating ||
                        attachments.isUploading ||
                        !isLaunchable
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

                {/* Footer row with target and model selectors */}
                <div className="flex flex-col gap-2 px-4 py-2 border-t border-border-muted sm:flex-row sm:items-center sm:justify-between sm:gap-0">
                  {/* Left side - Target selector + Model selector */}
                  <div className="flex flex-wrap items-center gap-2 sm:gap-4 min-w-0">
                    <SessionTargetPicker {...picker.pickerProps} disabled={creating} />

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

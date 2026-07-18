"use client";

import { useMemo } from "react";
import {
  CollapsibleSection,
  ParticipantsSection,
  MetadataSection,
  TasksSection,
  FilesChangedSection,
  MediaSection,
  CodeServerSection,
  TunnelUrlsSection,
} from "./sidebar";
import { ChildSessionsSection } from "./sidebar/child-sessions-section";
import { TerminalIcon, LinkIcon } from "@/components/ui/icons";
import { buildAuthenticatedUrl } from "@/lib/urls";
import { extractLatestTasks } from "@/lib/tasks";
import type { Artifact, SandboxEvent } from "@/types/session";
import type {
  ParticipantPresence,
  SessionDiffFile,
  SessionDiffRepository,
  SessionDiffState,
  SessionState,
} from "@open-inspect/shared";
import type { DiffSelection } from "@/lib/session-diffs";
import { deriveSessionDiffView } from "@/lib/session-diffs";
import { useSessionDiffRetry } from "@/hooks/use-session-diffs";

interface SessionRightSidebarProps {
  sessionId: string;
  sessionState: SessionState | null;
  participants: ParticipantPresence[];
  events: SandboxEvent[];
  artifacts: Artifact[];
  terminalOpen?: boolean;
  onToggleTerminal?: () => void;
  onOpenMedia: (artifactId: string) => void;
  diffState?: SessionDiffState | null;
  diffLoading?: boolean;
  selectedDiff?: DiffSelection | null;
  onOpenDiff?: (repository: SessionDiffRepository, file: SessionDiffFile) => void;
}

export type SessionRightSidebarContentProps = SessionRightSidebarProps;

export function SessionRightSidebarContent({
  sessionId,
  sessionState,
  participants,
  events,
  artifacts,
  terminalOpen,
  onToggleTerminal,
  onOpenMedia,
  diffState,
  diffLoading,
  selectedDiff,
  onOpenDiff,
}: SessionRightSidebarContentProps) {
  const tasks = useMemo(() => extractLatestTasks(events), [events]);
  const warnings = useMemo(
    () =>
      events.filter(
        (event): event is Extract<SandboxEvent, { type: "warning" }> => event.type === "warning"
      ),
    [events]
  );
  const mediaArtifacts = useMemo(
    () =>
      artifacts.filter((artifact) => artifact.type === "screenshot" || artifact.type === "video"),
    [artifacts]
  );
  const terminalUrl = useMemo(
    () => buildAuthenticatedUrl(sessionState?.ttydUrl, sessionState?.ttydToken),
    [sessionState?.ttydUrl, sessionState?.ttydToken]
  );
  const { retry, isRetrying, retryError } = useSessionDiffRetry(sessionId);
  const hasRepository = Boolean(
    sessionState?.repositories?.length || (sessionState?.repoOwner && sessionState.repoName)
  );
  const diffView = deriveSessionDiffView({
    hasRepository,
    isProcessing: sessionState?.isProcessing ?? false,
    state: diffState ?? null,
    isLoading: diffLoading ?? false,
  });

  if (!sessionState) {
    return (
      <div className="p-4">
        <div className="animate-pulse space-y-4">
          <div className="h-4 bg-muted w-3/4 rounded" />
          <div className="h-4 bg-muted w-1/2 rounded" />
          <div className="h-4 bg-muted w-2/3 rounded" />
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Participants */}
      <div className="px-4 py-4 border-b border-border-muted">
        <ParticipantsSection participants={participants} />
      </div>

      {/* Metadata */}
      <div className="px-4 py-4 border-b border-border-muted">
        <MetadataSection
          sessionId={sessionId}
          createdAt={sessionState.createdAt}
          model={sessionState.model}
          reasoningEffort={sessionState.reasoningEffort}
          baseBranch={sessionState.baseBranch}
          branchName={sessionState.branchName || undefined}
          repoOwner={sessionState.repoOwner}
          repoName={sessionState.repoName}
          artifacts={artifacts}
          repositories={sessionState.repositories}
          environmentId={sessionState.environmentId}
          environmentName={sessionState.environmentName}
          warnings={warnings}
          parentSessionId={sessionState.parentSessionId}
          totalCost={sessionState.totalCost}
        />
      </div>

      {/* Code Server */}
      {sessionState.codeServerUrl && (
        <div className="px-4 py-4 border-b border-border-muted">
          <CodeServerSection
            url={sessionState.codeServerUrl}
            password={sessionState.codeServerPassword ?? null}
            sandboxStatus={sessionState.sandboxStatus}
          />
        </div>
      )}

      {/* Terminal */}
      {sessionState.ttydUrl && terminalUrl && (
        <div className="px-4 py-4 border-b border-border-muted">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <TerminalIcon className="h-4 w-4" />
              <span className="font-medium">Terminal</span>
            </div>
            <div className="flex items-center gap-2">
              <a
                href={terminalUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="p-1 text-muted-foreground hover:text-foreground transition"
                title="Open in new tab"
              >
                <LinkIcon className="h-3.5 w-3.5" />
              </a>
              {onToggleTerminal && (
                <button
                  type="button"
                  onClick={onToggleTerminal}
                  className="text-xs text-accent hover:underline"
                >
                  {terminalOpen ? "Hide" : "Show"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Tunnel URLs */}
      {sessionState.tunnelUrls && Object.keys(sessionState.tunnelUrls).length > 0 && (
        <div className="px-4 py-4 border-b border-border-muted">
          <TunnelUrlsSection
            urls={sessionState.tunnelUrls}
            sandboxStatus={sessionState.sandboxStatus}
          />
        </div>
      )}

      {/* Tasks */}
      {tasks.length > 0 && (
        <CollapsibleSection title="Tasks" defaultOpen={true}>
          <TasksSection tasks={tasks} />
        </CollapsibleSection>
      )}

      {/* Child Sessions */}
      <ChildSessionsSection sessionId={sessionState.id} />

      {/* Canonical durable checkout changes */}
      {diffView.kind !== "hidden" && (
        <CollapsibleSection title="Changes" defaultOpen={true}>
          {diffView.showManifest && diffState?.current && onOpenDiff && (
            <FilesChangedSection
              repositories={diffState.current.repositories}
              selected={selectedDiff}
              onSelect={onOpenDiff}
            />
          )}
          <div role="status" aria-live="polite" className={diffView.showManifest ? "mt-2" : ""}>
            {diffView.kind === "loading" && (
              <p className="text-xs text-muted-foreground">Loading changes…</p>
            )}
            {diffView.kind === "error" && (
              <p className="text-xs text-destructive">Unable to load changes.</p>
            )}
            {diffView.kind === "unavailable" && (
              <p className="text-xs text-muted-foreground">{diffView.message}</p>
            )}
            {diffView.kind === "available_after_execution" && (
              <p className="text-xs text-muted-foreground">
                Changes will be available after the first execution.
              </p>
            )}
            {diffView.kind === "working" && (
              <p className="text-xs text-muted-foreground">
                {diffView.showManifest
                  ? "Agent working — showing the previous changes."
                  : "Changes will be available after this execution."}
              </p>
            )}
            {diffView.kind === "empty" && (
              <p className="text-xs text-muted-foreground">No file changes in the latest diff.</p>
            )}
            {diffView.kind === "failed" && (
              <div className="space-y-1.5">
                <p className="text-xs text-destructive">{diffView.message}</p>
                <button
                  type="button"
                  disabled={isRetrying}
                  onClick={() => void retry()}
                  className="text-xs font-medium text-accent underline underline-offset-2 disabled:opacity-50"
                >
                  {isRetrying ? "Retrying…" : "Retry changes refresh"}
                </button>
              </div>
            )}
            {retryError && <p className="mt-1.5 text-xs text-destructive">{retryError}</p>}
          </div>
        </CollapsibleSection>
      )}

      {/* Media */}
      {mediaArtifacts.length > 0 && (
        <CollapsibleSection title={`Media (${mediaArtifacts.length})`} defaultOpen={true}>
          <MediaSection
            sessionId={sessionId}
            mediaArtifacts={mediaArtifacts}
            onOpenMedia={onOpenMedia}
          />
        </CollapsibleSection>
      )}

      {/* Artifacts info when no specific sections are populated */}
      {tasks.length === 0 && artifacts.length === 0 && (
        <div className="px-4 py-4">
          <p className="text-sm text-muted-foreground">
            Tasks and artifacts will appear here as the agent works.
          </p>
        </div>
      )}
    </>
  );
}

export function SessionRightSidebar({
  sessionId,
  sessionState,
  participants,
  events,
  artifacts,
  terminalOpen,
  onToggleTerminal,
  onOpenMedia,
  diffState,
  diffLoading,
  selectedDiff,
  onOpenDiff,
}: SessionRightSidebarProps) {
  return (
    <aside className="w-80 border-l border-border-muted overflow-y-auto hidden lg:block">
      <SessionRightSidebarContent
        sessionId={sessionId}
        sessionState={sessionState}
        participants={participants}
        events={events}
        artifacts={artifacts}
        terminalOpen={terminalOpen}
        onToggleTerminal={onToggleTerminal}
        onOpenMedia={onOpenMedia}
        diffState={diffState}
        diffLoading={diffLoading}
        selectedDiff={selectedDiff}
        onOpenDiff={onOpenDiff}
      />
    </aside>
  );
}

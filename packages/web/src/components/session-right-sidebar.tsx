"use client";

import { useMemo } from "react";
import { CollapsibleSection } from "./sidebar/collapsible-section";
import { ParticipantsSection } from "./sidebar/participants-section";
import { MetadataSection } from "./sidebar/metadata-section";
import { TasksSection } from "./sidebar/tasks-section";
import { FilesChangedSection } from "./sidebar/files-changed-section";
import { MediaSection } from "./sidebar/media-section";
import { CodeServerSection } from "./sidebar/code-server-section";
import { VncSection } from "./sidebar/vnc-section";
import { TunnelUrlsSection } from "./sidebar/tunnel-urls-section";
import { ChildSessionsSection } from "./sidebar/child-sessions-section";
import { TerminalIcon, LinkIcon } from "@/components/ui/icons";
import { buildAuthenticatedUrl } from "@/lib/urls";
import { extractLatestTasks } from "@/lib/tasks";
import type { Artifact, SandboxEvent } from "@/types/session";
import type { ParticipantPresence, SessionState } from "@open-inspect/shared/types/server-messages";
import type {
  SessionDiffFile,
  SessionDiffRepository,
  SessionDiffState,
} from "@open-inspect/shared/types/session-diffs";
import type { DiffSelection } from "@/lib/session-diffs";
import { deriveSessionDiffView } from "@/lib/session-diffs";
import { DiffRetryNotice } from "@/components/diff-retry-notice";
import { ManagedSkillsSection } from "./sidebar/managed-skills-section";
import type { SessionCapabilities } from "@/lib/session-capabilities";

interface SessionRightSidebarProps {
  isOpen?: boolean;
  sessionId: string;
  sessionState: SessionState | null;
  participants: ParticipantPresence[];
  presenceSynced: boolean;
  events: SandboxEvent[];
  artifacts: Artifact[];
  terminalOpen?: boolean;
  onToggleTerminal?: () => void;
  onOpenMedia: (artifactId: string) => void;
  diffState?: SessionDiffState | null;
  diffLoading?: boolean;
  selectedDiff?: DiffSelection | null;
  onOpenDiff?: (repository: SessionDiffRepository, file: SessionDiffFile) => void;
  capabilities: SessionCapabilities;
}

export type SessionRightSidebarContentProps = SessionRightSidebarProps;

export function SessionRightSidebarContent({
  sessionId,
  sessionState,
  participants,
  presenceSynced,
  events,
  artifacts,
  terminalOpen,
  onToggleTerminal,
  onOpenMedia,
  diffState,
  diffLoading,
  selectedDiff,
  onOpenDiff,
  capabilities,
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
        <ParticipantsSection participants={participants} presenceSynced={presenceSynced} />
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
          canManageLifecycle={capabilities.lifecycle}
        />
      </div>

      {/* Code Server */}
      {capabilities.sandboxAccess && sessionState.codeServerUrl && (
        <div className="px-4 py-4 border-b border-border-muted">
          <CodeServerSection
            url={sessionState.codeServerUrl}
            password={sessionState.codeServerPassword ?? null}
            sandboxStatus={sessionState.sandboxStatus}
          />
        </div>
      )}

      {/* VNC Desktop */}
      {capabilities.sandboxAccess && sessionState.vncUrl && (
        <div className="px-4 py-4 border-b border-border-muted">
          <VncSection
            url={sessionState.vncUrl}
            password={sessionState.vncPassword ?? null}
            sandboxStatus={sessionState.sandboxStatus}
          />
        </div>
      )}

      {/* Terminal */}
      {capabilities.sandboxAccess && sessionState.ttydUrl && terminalUrl && (
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
      {capabilities.sandboxAccess &&
        sessionState.tunnelUrls &&
        Object.keys(sessionState.tunnelUrls).length > 0 && (
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

      <ManagedSkillsSection sessionId={sessionState.id} />

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
              <DiffRetryNotice
                sessionId={sessionId}
                message={diffView.message ?? ""}
                variant="inline"
                capabilities={capabilities}
              />
            )}
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
  isOpen = true,
  sessionId,
  sessionState,
  participants,
  presenceSynced,
  events,
  artifacts,
  terminalOpen,
  onToggleTerminal,
  onOpenMedia,
  diffState,
  diffLoading,
  selectedDiff,
  onOpenDiff,
  capabilities,
}: SessionRightSidebarProps) {
  return (
    <aside
      id="session-details-sidebar"
      aria-hidden={!isOpen}
      className={
        isOpen
          ? "hidden w-80 shrink-0 overflow-y-auto border-l border-border-muted lg:block"
          : "hidden"
      }
    >
      <SessionRightSidebarContent
        sessionId={sessionId}
        sessionState={sessionState}
        participants={participants}
        presenceSynced={presenceSynced}
        events={events}
        artifacts={artifacts}
        terminalOpen={terminalOpen}
        onToggleTerminal={onToggleTerminal}
        onOpenMedia={onOpenMedia}
        diffState={diffState}
        diffLoading={diffLoading}
        selectedDiff={selectedDiff}
        onOpenDiff={onOpenDiff}
        capabilities={capabilities}
      />
    </aside>
  );
}

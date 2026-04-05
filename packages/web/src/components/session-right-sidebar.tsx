"use client";

import { useMemo } from "react";
import {
  CollapsibleSection,
  ParticipantsSection,
  MetadataSection,
  TasksSection,
  FilesChangedSection,
  CodeServerSection,
  TunnelUrlsSection,
} from "./sidebar";
import { ChildSessionsSection } from "./sidebar/child-sessions-section";
import { TerminalIcon, LinkIcon } from "@/components/ui/icons";
import { buildAuthenticatedUrl } from "@/lib/urls";
import { extractLatestTasks } from "@/lib/tasks";
import { extractChangedFiles } from "@/lib/files";
import type { Artifact, SandboxEvent } from "@/types/session";
import type { ParticipantPresence, SessionState } from "@open-inspect/shared";

interface SessionRightSidebarProps {
  sessionState: SessionState | null;
  participants: ParticipantPresence[];
  events: SandboxEvent[];
  artifacts: Artifact[];
  terminalOpen?: boolean;
  onToggleTerminal?: () => void;
}

export type SessionRightSidebarContentProps = SessionRightSidebarProps;

export function SessionRightSidebarContent({
  sessionState,
  participants,
  events,
  artifacts,
  terminalOpen,
  onToggleTerminal,
}: SessionRightSidebarContentProps) {
  const tasks = useMemo(() => extractLatestTasks(events), [events]);
  const filesChanged = useMemo(() => extractChangedFiles(events), [events]);
  const terminalUrl = useMemo(
    () => buildAuthenticatedUrl(sessionState?.ttydUrl, sessionState?.ttydToken),
    [sessionState?.ttydUrl, sessionState?.ttydToken]
  );

  if (!sessionState) {
    return (
      <div className="p-4">
        <div className="animate-pulse space-y-4">
          <div className="h-4 bg-muted w-3/4" />
          <div className="h-4 bg-muted w-1/2" />
          <div className="h-4 bg-muted w-2/3" />
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
          createdAt={sessionState.createdAt}
          model={sessionState.model}
          reasoningEffort={sessionState.reasoningEffort}
          baseBranch={sessionState.baseBranch}
          branchName={sessionState.branchName || undefined}
          repoOwner={sessionState.repoOwner}
          repoName={sessionState.repoName}
          artifacts={artifacts}
          parentSessionId={sessionState.parentSessionId}
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
                <button onClick={onToggleTerminal} className="text-xs text-accent hover:underline">
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

      {/* Files Changed */}
      {filesChanged.length > 0 && (
        <CollapsibleSection title="Files changed" defaultOpen={true}>
          <FilesChangedSection files={filesChanged} />
        </CollapsibleSection>
      )}

      {/* Artifacts info when no specific sections are populated */}
      {tasks.length === 0 && filesChanged.length === 0 && artifacts.length === 0 && (
        <div className="px-4 py-4">
          <p className="text-sm text-muted-foreground">
            Tasks and file changes will appear here as the agent works.
          </p>
        </div>
      )}
    </>
  );
}

export function SessionRightSidebar({
  sessionState,
  participants,
  events,
  artifacts,
  terminalOpen,
  onToggleTerminal,
}: SessionRightSidebarProps) {
  return (
    <aside className="w-80 border-l border-border-muted overflow-y-auto hidden lg:block">
      <SessionRightSidebarContent
        sessionState={sessionState}
        participants={participants}
        events={events}
        artifacts={artifacts}
        terminalOpen={terminalOpen}
        onToggleTerminal={onToggleTerminal}
      />
    </aside>
  );
}

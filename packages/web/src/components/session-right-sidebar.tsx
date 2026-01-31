"use client";

import { useMemo } from "react";
import {
  CollapsibleSection,
  ParticipantsSection,
  MetadataSection,
  TasksSection,
  FilesChangedSection,
  ArtifactsSection,
} from "./sidebar";
import { extractLatestTasks } from "@/lib/tasks";
import type { Artifact, FileChange, TaskLinearLink } from "@/types/session";

interface SessionState {
  id: string;
  title: string | null;
  repoOwner: string;
  repoName: string;
  branchName: string | null;
  status: string;
  sandboxStatus: string;
  messageCount: number;
  createdAt: number;
  model?: string;
  linearIssueId?: string;
  linearTeamId?: string;
  taskLinearLinks?: TaskLinearLink[];
}

interface Participant {
  userId: string;
  name: string;
  avatar?: string;
  status: "active" | "idle" | "away";
  lastSeen: number;
}

interface SandboxEvent {
  type: string;
  tool?: string;
  args?: Record<string, unknown>;
  timestamp: number;
  id?: string;
  messageId?: string;
}

interface SessionRightSidebarProps {
  sessionId: string;
  sessionState: SessionState | null;
  participants: Participant[];
  events: SandboxEvent[];
  artifacts: Artifact[];
  filesChanged?: FileChange[];
}

export function SessionRightSidebar({
  sessionId,
  sessionState,
  participants,
  events,
  artifacts,
  filesChanged = [],
}: SessionRightSidebarProps) {
  // Extract latest tasks from TodoWrite events (with messageId/eventId/taskIndex for Linear)
  const tasks = useMemo(() => extractLatestTasks(events), [events]);
  const taskLinearLinks = sessionState?.taskLinearLinks ?? [];

  if (!sessionState) {
    return (
      <aside className="w-80 border-l border-border-muted overflow-y-auto hidden lg:block">
        <div className="p-4">
          <div className="animate-pulse space-y-4">
            <div className="h-4 bg-muted w-3/4" />
            <div className="h-4 bg-muted w-1/2" />
            <div className="h-4 bg-muted w-2/3" />
          </div>
        </div>
      </aside>
    );
  }

  return (
    <aside className="w-80 border-l border-border-muted overflow-y-auto hidden lg:block">
      {/* Participants */}
      <div className="px-4 py-4 border-b border-border-muted">
        <ParticipantsSection participants={participants} />
      </div>

      {/* Metadata */}
      <div className="px-4 py-4 border-b border-border-muted">
        <MetadataSection
          createdAt={sessionState.createdAt}
          model={sessionState.model}
          branchName={sessionState.branchName || undefined}
          repoOwner={sessionState.repoOwner}
          repoName={sessionState.repoName}
          artifacts={artifacts}
          linearIssueId={sessionState.linearIssueId}
        />
      </div>

      {/* Tasks */}
      {tasks.length > 0 && (
        <CollapsibleSection title="Tasks" defaultOpen={true}>
          <TasksSection sessionId={sessionId} tasks={tasks} taskLinearLinks={taskLinearLinks} />
        </CollapsibleSection>
      )}

      {/* Files Changed */}
      {filesChanged.length > 0 && (
        <CollapsibleSection title="Files changed" defaultOpen={true}>
          <FilesChangedSection files={filesChanged} />
        </CollapsibleSection>
      )}

      {/* Artifacts (PR, screenshots, preview) */}
      {artifacts.length > 0 && (
        <CollapsibleSection title="Artifacts" defaultOpen={true}>
          <ArtifactsSection artifacts={artifacts} />
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
    </aside>
  );
}

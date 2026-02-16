"use client";

import { useMemo } from "react";
import {
  CollapsibleSection,
  ParticipantsSection,
  MetadataSection,
  TasksSection,
  FilesChangedSection,
  ScreenshotsSection,
} from "./sidebar";
import { extractLatestTasks } from "@/lib/tasks";
import type { Artifact, FileChange } from "@/types/session";

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
  reasoningEffort?: string;
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
}

interface SessionRightSidebarProps {
  sessionState: SessionState | null;
  participants: Participant[];
  events: SandboxEvent[];
  artifacts: Artifact[];
  filesChanged?: FileChange[];
}

export function SessionRightSidebar({
  sessionState,
  participants,
  events,
  artifacts,
  filesChanged = [],
}: SessionRightSidebarProps) {
  // Extract latest tasks from TodoWrite events
  const tasks = useMemo(() => extractLatestTasks(events), [events]);

  // Filter screenshot artifacts
  const screenshots = useMemo(
    () => artifacts.filter((a) => a.type === "screenshot"),
    [artifacts]
  );

  if (!sessionState) {
    return (
      <aside className="w-80 border-l border-ash-200 overflow-y-auto hidden lg:block bg-white">
        <div className="p-4">
          <div className="animate-pulse space-y-4">
            <div className="h-4 bg-ash-200 rounded w-3/4" />
            <div className="h-4 bg-ash-200 rounded w-1/2" />
            <div className="h-4 bg-ash-200 rounded w-2/3" />
          </div>
        </div>
      </aside>
    );
  }

  return (
    <aside className="w-80 border-l border-ash-200 overflow-y-auto hidden lg:block bg-white">
      {/* participants */}
      <div className="px-4 py-4 border-b border-ash-200">
        <ParticipantsSection participants={participants} />
      </div>

      {/* metadata */}
      <div className="px-4 py-4 border-b border-ash-200">
        <MetadataSection
          createdAt={sessionState.createdAt}
          model={sessionState.model}
          reasoningEffort={sessionState.reasoningEffort}
          branchName={sessionState.branchName || undefined}
          repoOwner={sessionState.repoOwner}
          repoName={sessionState.repoName}
          artifacts={artifacts}
        />
      </div>

      {/* Tasks */}
      {tasks.length > 0 && (
        <CollapsibleSection title="Tasks" defaultOpen={true}>
          <TasksSection tasks={tasks} />
        </CollapsibleSection>
      )}

      {/* Screenshots */}
      {screenshots.length > 0 && (
        <CollapsibleSection title="Screenshots" defaultOpen={true}>
          <ScreenshotsSection screenshots={screenshots} />
        </CollapsibleSection>
      )}

      {/* Files Changed */}
      {filesChanged.length > 0 && (
        <CollapsibleSection title="Files changed" defaultOpen={true}>
          <FilesChangedSection files={filesChanged} />
        </CollapsibleSection>
      )}

      {/* Artifacts info when no specific sections are populated */}
      {tasks.length === 0 && filesChanged.length === 0 && artifacts.length === 0 && (
        <div className="px-4 py-4">
          <p className="text-sm text-ash-500">
            Tasks and file changes will appear here as the agent works.
          </p>
        </div>
      )}
    </aside>
  );
}

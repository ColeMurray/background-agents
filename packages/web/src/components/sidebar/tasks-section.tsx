"use client";

import { useState, useCallback, useEffect } from "react";
import type { Task, TaskLinearLink } from "@/types/session";
import {
  listLinearTeams,
  listLinearIssues,
  linkTaskToLinear,
  createLinearIssueFromTask,
} from "@/lib/linear";
import type { LinearTeam } from "@/lib/linear";
import type { LinearIssue } from "@/types/session";

interface TasksSectionProps {
  sessionId: string;
  tasks: Task[];
  taskLinearLinks: TaskLinearLink[];
}

function taskKey(link: TaskLinearLink): string {
  return `${link.messageId}:${link.eventId}:${link.taskIndex}`;
}

function getLinkForTask(task: Task, taskLinearLinks: TaskLinearLink[]): TaskLinearLink | undefined {
  if (task.messageId == null || task.eventId == null || task.taskIndex == null) return undefined;
  const key = `${task.messageId}:${task.eventId}:${task.taskIndex}`;
  return taskLinearLinks.find((l) => taskKey(l) === key);
}

export function TasksSection({ sessionId, tasks, taskLinearLinks }: TasksSectionProps) {
  if (tasks.length === 0) return null;

  return (
    <div className="space-y-2">
      {tasks.map((task, index) => (
        <TaskItem
          key={`${task.content}-${task.eventId ?? ""}-${index}`}
          sessionId={sessionId}
          task={task}
          link={getLinkForTask(task, taskLinearLinks)}
        />
      ))}
    </div>
  );
}

function TaskItem({
  sessionId,
  task,
  link,
}: {
  sessionId: string;
  task: Task;
  link: TaskLinearLink | undefined;
}) {
  const [linkModalOpen, setLinkModalOpen] = useState(false);
  const [createModalOpen, setCreateModalOpen] = useState(false);

  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <div className="flex items-start gap-2">
        <TaskStatusIcon status={task.status} />
        <span
          className={`flex-1 ${
            task.status === "completed"
              ? "text-secondary-foreground line-through"
              : "text-foreground"
          }`}
        >
          {task.status === "in_progress" && task.activeForm ? task.activeForm : task.content}
        </span>
      </div>
      <div className="flex items-center gap-2 pl-6">
        {link ? (
          <a
            href={`https://linear.app/issue/${link.linearIssueId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
          >
            <LinearIcon className="w-3.5 h-3.5" />
            Linear
          </a>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setLinkModalOpen(true)}
              className="text-xs text-muted-foreground hover:text-accent"
            >
              Link to Linear
            </button>
            <span className="text-muted-foreground">·</span>
            <button
              type="button"
              onClick={() => setCreateModalOpen(true)}
              className="text-xs text-muted-foreground hover:text-accent"
            >
              Create issue
            </button>
          </>
        )}
      </div>
      {linkModalOpen && (
        <LinkToLinearModal
          sessionId={sessionId}
          task={task}
          onClose={() => setLinkModalOpen(false)}
        />
      )}
      {createModalOpen && (
        <CreateLinearIssueModal
          sessionId={sessionId}
          task={task}
          onClose={() => setCreateModalOpen(false)}
        />
      )}
    </div>
  );
}

function LinkToLinearModal({
  sessionId,
  task,
  onClose,
}: {
  sessionId: string;
  task: Task;
  onClose: () => void;
}) {
  const [teams, setTeams] = useState<LinearTeam[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string>("");
  const [issues, setIssues] = useState<LinearIssue[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadTeams = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const t = await listLinearTeams();
      setTeams(t);
      if (t.length > 0) setSelectedTeamId((prev) => prev || t[0].id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load teams");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadIssues = useCallback(async () => {
    if (!selectedTeamId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await listLinearIssues({ teamId: selectedTeamId, limit: 50 });
      setIssues(result.issues);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load issues");
    } finally {
      setLoading(false);
    }
  }, [selectedTeamId]);

  useEffect(() => {
    loadTeams();
  }, [loadTeams]);

  useEffect(() => {
    if (selectedTeamId) loadIssues();
  }, [selectedTeamId, loadIssues]);

  const handleTeamChange = (teamId: string) => {
    setSelectedTeamId(teamId);
    setIssues([]);
  };

  const handleLink = async (issueId: string) => {
    if (task.messageId == null || task.eventId == null || task.taskIndex == null) return;
    setLoading(true);
    setError(null);
    try {
      await linkTaskToLinear(sessionId, {
        messageId: task.messageId,
        eventId: task.eventId,
        taskIndex: task.taskIndex,
        linearIssueId: issueId,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to link");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="bg-background border border-border rounded-lg shadow-lg p-4 w-full max-w-md max-h-[80vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-medium mb-3">Link to Linear</h3>
        {error && <p className="text-destructive text-sm mb-2">{error}</p>}
        <div className="space-y-2 mb-3">
          <label className="block text-xs text-muted-foreground">Team</label>
          <select
            className="w-full border border-border rounded px-2 py-1.5 text-sm bg-background"
            value={selectedTeamId}
            onChange={(e) => handleTeamChange(e.target.value)}
            onFocus={loadTeams}
          >
            <option value="">Select team</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.key})
              </option>
            ))}
          </select>
        </div>
        {selectedTeamId && (
          <div className="space-y-2 mb-3">
            <label className="block text-xs text-muted-foreground">Issue</label>
            <ul className="max-h-48 overflow-y-auto border border-border rounded divide-y divide-border">
              {issues.map((issue) => (
                <li key={issue.id} className="px-2 py-1.5 flex items-center justify-between gap-2">
                  <span className="text-sm truncate">
                    {issue.identifier}: {issue.title}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleLink(issue.id)}
                    disabled={loading}
                    className="text-xs text-accent hover:underline flex-shrink-0"
                  >
                    Link
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex justify-end gap-2 mt-3">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm border border-border rounded hover:bg-muted"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function CreateLinearIssueModal({
  sessionId,
  task,
  onClose,
}: {
  sessionId: string;
  task: Task;
  onClose: () => void;
}) {
  const [teams, setTeams] = useState<LinearTeam[]>([]);
  const [selectedTeamId, setSelectedTeamId] = useState<string>("");
  const [title, setTitle] = useState(task.content.slice(0, 120));
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadTeams = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const t = await listLinearTeams();
      setTeams(t);
      if (t.length > 0) setSelectedTeamId((prev) => prev || t[0].id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load teams");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTeams();
  }, [loadTeams]);

  const handleCreate = async () => {
    if (
      !selectedTeamId ||
      task.messageId == null ||
      task.eventId == null ||
      task.taskIndex == null
    ) {
      setError("Team is required");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await createLinearIssueFromTask(sessionId, {
        messageId: task.messageId,
        eventId: task.eventId,
        taskIndex: task.taskIndex,
        teamId: selectedTeamId,
        title: title.trim() || task.content.slice(0, 120),
        description: description.trim() || undefined,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create issue");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="bg-background border border-border rounded-lg shadow-lg p-4 w-full max-w-md max-h-[80vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-medium mb-3">Create Linear issue</h3>
        {error && <p className="text-destructive text-sm mb-2">{error}</p>}
        <div className="space-y-2 mb-3">
          <label className="block text-xs text-muted-foreground">Team (required)</label>
          <select
            className="w-full border border-border rounded px-2 py-1.5 text-sm bg-background"
            value={selectedTeamId}
            onChange={(e) => setSelectedTeamId(e.target.value)}
            onFocus={loadTeams}
          >
            <option value="">Select team</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.key})
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2 mb-3">
          <label className="block text-xs text-muted-foreground">Title</label>
          <input
            type="text"
            className="w-full border border-border rounded px-2 py-1.5 text-sm bg-background"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Issue title"
          />
        </div>
        <div className="space-y-2 mb-3">
          <label className="block text-xs text-muted-foreground">Description (optional)</label>
          <textarea
            className="w-full border border-border rounded px-2 py-1.5 text-sm bg-background min-h-[60px]"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description"
          />
        </div>
        <div className="flex justify-end gap-2 mt-3">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm border border-border rounded hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleCreate}
            disabled={loading || !selectedTeamId}
            className="px-3 py-1.5 text-sm bg-accent text-accent-foreground rounded hover:opacity-90 disabled:opacity-50"
          >
            {loading ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

function TaskStatusIcon({ status }: { status: Task["status"] }) {
  switch (status) {
    case "in_progress":
      return (
        <span className="mt-0.5 flex-shrink-0">
          <ClockIcon className="w-4 h-4 text-accent animate-pulse" />
        </span>
      );
    case "completed":
      return (
        <span className="mt-0.5 flex-shrink-0">
          <CheckCircleIcon className="w-4 h-4 text-success" />
        </span>
      );
    case "pending":
    default:
      return (
        <span className="mt-0.5 flex-shrink-0">
          <EmptyCircleIcon className="w-4 h-4 text-secondary-foreground" />
        </span>
      );
  }
}

function LinearIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M13.5 3H3v10.5h10.5V3zM21 3h-7.5v4.5H21V3zM21 10.5h-7.5V21H21V10.5zM13.5 16.5V21H3v-4.5h10.5z" />
    </svg>
  );
}

function ClockIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="10" strokeWidth={2} />
      <path strokeLinecap="round" strokeWidth={2} d="M12 6v6l4 2" />
    </svg>
  );
}

function CheckCircleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  );
}

function EmptyCircleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="9" strokeWidth={2} />
    </svg>
  );
}

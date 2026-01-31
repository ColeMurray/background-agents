/**
 * Linear API helpers (client-side).
 * Calls web app API routes that proxy to the control plane.
 */

import type { LinearIssue } from "@/types/session";

export interface LinearTeam {
  id: string;
  key: string;
  name: string;
}

export async function listLinearTeams(): Promise<LinearTeam[]> {
  const res = await fetch("/api/linear/teams");
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? "Failed to list Linear teams");
  }
  const data = (await res.json()) as { teams: LinearTeam[] };
  return data.teams ?? [];
}

export interface ListLinearIssuesParams {
  teamId?: string;
  teamKey?: string;
  query?: string;
  cursor?: string;
  limit?: number;
}

export interface ListLinearIssuesResult {
  issues: LinearIssue[];
  cursor: string | null;
  hasMore: boolean;
}

export async function listLinearIssues(
  params: ListLinearIssuesParams = {}
): Promise<ListLinearIssuesResult> {
  const search = new URLSearchParams();
  if (params.teamId) search.set("teamId", params.teamId);
  if (params.teamKey) search.set("teamKey", params.teamKey);
  if (params.query) search.set("query", params.query);
  if (params.cursor) search.set("cursor", params.cursor);
  if (params.limit != null) search.set("limit", String(params.limit));
  const qs = search.toString();
  const url = qs ? `/api/linear/issues?${qs}` : "/api/linear/issues";
  const res = await fetch(url);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? "Failed to list Linear issues");
  }
  return res.json() as Promise<ListLinearIssuesResult>;
}

export async function linkTaskToLinear(
  sessionId: string,
  payload: { messageId: string; eventId: string; taskIndex: number; linearIssueId: string }
): Promise<void> {
  const res = await fetch(`/api/sessions/${sessionId}/linear/link-task`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? "Failed to link task to Linear");
  }
}

export async function createLinearIssueFromTask(
  sessionId: string,
  payload: {
    messageId: string;
    eventId: string;
    taskIndex: number;
    teamId: string;
    title?: string;
    description?: string;
  }
): Promise<{ issue: LinearIssue; linked: boolean }> {
  const res = await fetch(`/api/sessions/${sessionId}/linear/create-issue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? "Failed to create Linear issue");
  }
  return res.json() as Promise<{ issue: LinearIssue; linked: boolean }>;
}

export async function updateLinearIssue(
  issueId: string,
  payload: { stateId?: string; assigneeId?: string | null; title?: string; description?: string }
): Promise<LinearIssue> {
  const res = await fetch(`/api/linear/issues/${encodeURIComponent(issueId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? "Failed to update Linear issue");
  }
  return res.json() as Promise<LinearIssue>;
}

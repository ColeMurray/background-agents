import {
  buildAgentResponseFromEvents,
  getArtifactLabelFromArtifact,
  type ArtifactInfo,
  type ChildSessionDetail,
  type ChildSessionFinalResponse,
  type ChildSessionTrajectory,
  type EventResponse,
} from "@open-inspect/shared";
import {
  encodeEventTimelineCursor,
  parseEventTimelineCursor,
  type EventTimelineCursor,
} from "../../event-cursor";
import type { ArtifactRow, EventRow, MessageRow, SandboxRow, SessionRow } from "../../types";

const CHILD_SESSION_DETAIL_INCLUDES = ["result", "trajectory"] as const;

export const RECENT_EVENT_FETCH_LIMIT = 50;
export const FINAL_RESPONSE_EVENT_PAGE_LIMIT = 200;
export const FINAL_RESPONSE_MAX_EVENTS = 1000;

const RECENT_EVENT_DISPLAY_LIMIT = 5;
const DEFAULT_TRAJECTORY_EVENT_LIMIT = 200;
const MAX_TRAJECTORY_EVENT_LIMIT = 1000;
const NOISY_RECENT_EVENT_TYPES = new Set(["token", "heartbeat", "step_start", "step_finish"]);
const CHILD_SUMMARY_INCLUDE_VALUES = new Set<string>(CHILD_SESSION_DETAIL_INCLUDES);

export interface ChildSummaryOptions {
  includeFinalResponse: boolean;
  includeTrajectory: boolean;
  trajectoryLimit: number;
  trajectoryCursor: EventTimelineCursor | null;
}

export type ChildSummaryOptionsResult =
  | { ok: true; options: ChildSummaryOptions }
  | { ok: false; error: string };

export interface ChildSummaryFinalResponseInput {
  message: MessageRow | null;
  eventRows: EventRow[];
  eventLimitReached: boolean;
}

export interface ChildSummaryTrajectoryInput {
  eventRows: EventRow[];
  hasMore: boolean;
  nextCursor: EventTimelineCursor | null;
  limit: number;
}

export interface BuildChildSessionDetailInput {
  session: SessionRow;
  sandbox: SandboxRow | null;
  publicSessionId: string;
  artifacts: ArtifactRow[];
  recentEventRows: EventRow[];
  parseArtifactMetadata: (
    artifact: Pick<ArtifactRow, "id" | "metadata">
  ) => Record<string, unknown> | null;
  finalResponse?: ChildSummaryFinalResponseInput;
  trajectory?: ChildSummaryTrajectoryInput;
}

export interface FinalResponseEventPageSource {
  listEventPage(options: {
    cursor?: EventTimelineCursor | null;
    limit: number;
    messageId: string;
  }): {
    events: EventRow[];
    hasMore: boolean;
    nextCursor: EventTimelineCursor | null;
  };
}

export interface CollectedFinalResponseEvents {
  eventRows: EventRow[];
  eventLimitReached: boolean;
}

export function parseChildSummaryOptions(url?: URL): ChildSummaryOptionsResult {
  const includeValuesResult = parseIncludeValues(url?.searchParams.getAll("include") ?? []);
  if (!includeValuesResult.ok) {
    return { ok: false, error: includeValuesResult.error };
  }

  const includeTrajectory = includeValuesResult.values.has("trajectory");
  const includeFinalResponse = includeValuesResult.values.has("result") || includeTrajectory;
  const trajectoryLimitResult = includeTrajectory
    ? parseLimit(
        url?.searchParams.get("trajectoryLimit"),
        DEFAULT_TRAJECTORY_EVENT_LIMIT,
        MAX_TRAJECTORY_EVENT_LIMIT,
        "trajectoryLimit"
      )
    : { ok: true as const, value: DEFAULT_TRAJECTORY_EVENT_LIMIT };
  if (!trajectoryLimitResult.ok) {
    return { ok: false, error: trajectoryLimitResult.error };
  }
  const cursorResult = includeTrajectory
    ? parseTrajectoryCursor(url?.searchParams.get("trajectoryCursor"))
    : { ok: true as const, cursor: null };
  if (!cursorResult.ok) {
    return { ok: false, error: cursorResult.error };
  }

  return {
    ok: true,
    options: {
      includeFinalResponse,
      includeTrajectory,
      trajectoryLimit: trajectoryLimitResult.value,
      trajectoryCursor: cursorResult.cursor,
    },
  };
}

export function collectFinalResponseEventRows(
  source: FinalResponseEventPageSource,
  messageId: string
): CollectedFinalResponseEvents {
  const eventRows: EventRow[] = [];
  let cursor: EventTimelineCursor | null = null;

  while (eventRows.length < FINAL_RESPONSE_MAX_EVENTS) {
    const remaining = FINAL_RESPONSE_MAX_EVENTS - eventRows.length;
    const page = source.listEventPage({
      limit: Math.min(FINAL_RESPONSE_EVENT_PAGE_LIMIT, remaining),
      messageId,
      ...(cursor ? { cursor } : {}),
    });

    eventRows.push(...page.events);
    if (!page.hasMore) {
      return { eventRows, eventLimitReached: false };
    }

    if (!page.nextCursor) {
      return { eventRows, eventLimitReached: false };
    }
    cursor = page.nextCursor;
  }

  return { eventRows, eventLimitReached: true };
}

export function buildChildSessionDetail(input: BuildChildSessionDetailInput): ChildSessionDetail {
  const artifacts = input.artifacts.map((artifact) => ({
    row: artifact,
    metadata: input.parseArtifactMetadata(artifact),
  }));
  const recentEvents = input.recentEventRows
    .filter((event) => !NOISY_RECENT_EVENT_TYPES.has(event.type))
    .slice(0, RECENT_EVENT_DISPLAY_LIMIT);

  const detail: ChildSessionDetail = {
    session: {
      id: input.publicSessionId,
      title: input.session.title ?? "",
      status: input.session.status,
      repoOwner: input.session.repo_owner,
      repoName: input.session.repo_name,
      branchName: input.session.branch_name,
      model: input.session.model,
      createdAt: input.session.created_at,
      updatedAt: input.session.updated_at,
    },
    sandbox: input.sandbox ? { status: input.sandbox.status } : null,
    artifacts: artifacts.map(({ row, metadata }) => ({
      type: row.type,
      url: row.url ?? "",
      metadata,
    })),
    recentEvents: recentEvents.map((event) => ({
      type: event.type,
      data: parseJsonRecord(event.data),
      createdAt: event.created_at,
    })),
  };

  if (input.finalResponse) {
    const artifactInfos = artifacts
      .map(({ row, metadata }) => buildArtifactInfo(row, metadata))
      .filter((artifact): artifact is ArtifactInfo => artifact !== null);
    detail.finalResponse = buildFinalResponse(
      input.finalResponse.message,
      input.finalResponse.eventRows,
      artifactInfos,
      input.finalResponse.eventLimitReached
    );
  }

  if (input.trajectory) {
    detail.trajectory = buildTrajectory(input.trajectory);
  }

  return detail;
}

function parseIncludeValues(
  rawValues: string[]
): { ok: true; values: Set<string> } | { ok: false; error: string } {
  const values = new Set<string>();

  for (const rawValue of rawValues) {
    for (const value of rawValue.split(",")) {
      const trimmed = value.trim();
      if (!trimmed) continue;
      if (!CHILD_SUMMARY_INCLUDE_VALUES.has(trimmed)) {
        return { ok: false, error: `Invalid include: ${trimmed}` };
      }
      values.add(trimmed);
    }
  }

  return { ok: true, values };
}

function parseLimit(
  raw: string | null | undefined,
  fallback: number,
  max: number,
  fieldName: string
): { ok: true; value: number } | { ok: false; error: string } {
  if (raw == null || raw === "") {
    return { ok: true, value: fallback };
  }

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return { ok: false, error: `Invalid ${fieldName}` };
  }

  return { ok: true, value: Math.min(parsed, max) };
}

function parseTrajectoryCursor(
  raw: string | null | undefined
): { ok: true; cursor: EventTimelineCursor | null } | { ok: false; error: string } {
  if (!raw) return { ok: true, cursor: null };

  return parseEventTimelineCursor(raw, "trajectoryCursor");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonRecord(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : { value: parsed };
  } catch {
    return { value: raw };
  }
}

function toEventResponse(event: EventRow): EventResponse {
  return {
    id: event.id,
    type: event.type,
    data: parseJsonRecord(event.data),
    messageId: event.message_id,
    createdAt: event.created_at,
  };
}

function buildArtifactInfo(
  artifact: ArtifactRow,
  metadata: Record<string, unknown> | null
): ArtifactInfo | null {
  if (artifact.type === "screenshot" || artifact.type === "video") return null;

  return {
    type: artifact.type,
    url: artifact.url ?? "",
    label: getArtifactLabelFromArtifact(artifact.type, metadata),
    metadata,
  };
}

function buildFinalResponse(
  message: MessageRow | null,
  eventRows: EventRow[],
  artifacts: ArtifactInfo[],
  eventLimitReached: boolean
): ChildSessionFinalResponse | null {
  if (!message) return null;

  const events = eventRows.map(toEventResponse);
  return {
    ...buildAgentResponseFromEvents(events, artifacts, {
      defaultSuccess: message.status === "completed",
    }),
    messageId: message.id,
    completedAt: message.completed_at,
    eventCount: events.length,
    eventLimitReached,
  };
}

function buildTrajectory(input: ChildSummaryTrajectoryInput): ChildSessionTrajectory {
  const events = input.eventRows.map(toEventResponse);

  return {
    events,
    hasMore: input.hasMore,
    cursor:
      input.hasMore && input.nextCursor ? encodeEventTimelineCursor(input.nextCursor) : undefined,
    limit: input.limit,
  };
}

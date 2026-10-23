import type { JsonValue } from "@earendil-works/chord";

/**
 * The sanitized view of Pi's live work.
 *
 * It is what an operator sees. It names identifiers, kinds, phases, and
 * outcomes. It never carries a prompt, a tool argument, a tool result, a
 * credential, or an internal request prefix.
 */

/** The parts of Pi's inspection this module reads. */
export interface PiInspectionTask {
  readonly record: {
    readonly id: number;
    readonly kind: string;
    readonly conversationId: number;
    readonly state: unknown;
  };
  readonly state: { readonly kind: string };
}

export type PiAgentActivityStatus = "active" | "queued" | "sleeping" | "parked" | "idle";

/** Summarize Pi 1.4 task states without treating durable sleep or parking as CPU-active work. */
export function piAgentActivityStatus(
  tasks: readonly Pick<PiInspectionTask, "state">[],
  queued: number,
  placed: number
): PiAgentActivityStatus {
  if (
    placed > 0 ||
    tasks.some(({ state }) => state.kind !== "sleeping" && state.kind !== "blocked")
  ) {
    return "active";
  }
  if (
    tasks.some(
      ({ state }) =>
        state.kind === "blocked" &&
        "reason" in state &&
        (state as { reason?: string }).reason === "restart_limit"
    )
  ) {
    return "parked";
  }
  if (tasks.some(({ state }) => state.kind === "sleeping")) return "sleeping";
  return queued > 0 ? "queued" : "idle";
}

export interface PiInspection {
  readonly scheduling: string;
  readonly tasks: readonly PiInspectionTask[];
  readonly submissions: readonly {
    readonly id: number;
    readonly conversationId: number;
    readonly requestId?: string;
    readonly type: string;
    readonly status: string;
    readonly entry?: unknown;
    readonly answer?: unknown;
  }[];
}

/**
 * Why a task cannot run here.
 *
 * The reason is a fixed vocabulary, so it never carries content. The detail
 * behind it is bounded, because a failed migration may name a task
 * definition.
 */
export function piBlockedReason(state: { readonly kind: string }): JsonValue {
  if (state.kind !== "blocked") return null;
  const blocked = state as {
    readonly kind: "blocked";
    readonly reason?: string;
    readonly error?: unknown;
  };
  const detail = typeof blocked.error === "string" ? blocked.error.slice(0, 200) : null;
  return {
    reason: blocked.reason ?? "unknown",
    ...(detail ? { detail } : {}),
  };
}

/**
 * The sanitized inspection.
 *
 * A blocked task says why it cannot run: without the reason, a stalled
 * session is a puzzle rather than a diagnostic.
 */
export function sanitizePiInspection(
  inspection: PiInspection,
  mapRequestId: (requestId: string | undefined) => string | undefined
): JsonValue {
  return {
    scheduling: inspection.scheduling,
    tasks: inspection.tasks.slice(0, 64).map(({ record, state }) => ({
      id: record.id,
      kind: record.kind,
      conversationId: record.conversationId,
      state: {
        kind: state.kind,
        ...("phase" in (record.state as object) && record.state !== null
          ? { phase: (record.state as { phase?: unknown }).phase }
          : {}),
        ...(state.kind === "blocked" ? { blocked: piBlockedReason(state) } : {}),
      },
    })),
    submissions: inspection.submissions.slice(-200).map((submission) => ({
      id: submission.id,
      conversationId: submission.conversationId,
      requestId: mapRequestId(submission.requestId),
      type: submission.type,
      status: submission.status,
      ...("entry" in submission && submission.entry !== undefined
        ? { entry: submission.entry }
        : {}),
      ...("answer" in submission && submission.answer !== undefined
        ? { answer: submission.answer }
        : {}),
    })),
  } as unknown as JsonValue;
}

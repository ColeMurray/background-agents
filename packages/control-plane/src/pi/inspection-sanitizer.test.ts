import { describe, expect, it } from "vitest";
import {
  piAgentActivityStatus,
  piBlockedReason,
  sanitizePiInspection,
} from "./inspection-sanitizer";

function inspection(overrides: Partial<Parameters<typeof sanitizePiInspection>[0]> = {}) {
  return {
    scheduling: "running",
    tasks: [
      {
        record: { id: 7, kind: "pi.generation", conversationId: 1, state: { phase: "answer" } },
        state: { kind: "running" },
      },
    ],
    submissions: [
      {
        id: 3,
        conversationId: 1,
        requestId: "open-inspect-control:message-1",
        type: "input",
        status: "placed",
      },
    ],
    ...overrides,
  };
}

describe("the sanitized Pi inspection", () => {
  it("names the task, its kind, and its phase", () => {
    const result = sanitizePiInspection(inspection(), (requestId) => requestId) as {
      tasks: Array<Record<string, unknown>>;
    };

    expect(result.tasks[0]).toMatchObject({
      id: 7,
      kind: "pi.generation",
      conversationId: 1,
      state: { kind: "running", phase: "answer" },
    });
  });

  it("names why a blocked task cannot run", () => {
    const result = sanitizePiInspection(
      inspection({
        tasks: [
          {
            record: { id: 9, kind: "pi.tool", conversationId: 1, state: {} },
            state: {
              kind: "blocked",
              reason: "missing_task",
              error: "no definition for pi.tool",
            } as never,
          },
        ],
      }),
      (requestId) => requestId
    ) as { tasks: Array<{ state: { blocked: { reason: string; detail?: string } } }> };

    expect(result.tasks[0]?.state.blocked).toEqual({
      reason: "missing_task",
      detail: "no definition for pi.tool",
    });
  });

  it("keeps a blocked task's detail bounded", () => {
    const result = sanitizePiInspection(
      inspection({
        tasks: [
          {
            record: { id: 9, kind: "pi.tool", conversationId: 1, state: {} },
            state: {
              kind: "blocked",
              reason: "migration_failed",
              error: "x".repeat(1_000),
            } as never,
          },
        ],
      }),
      (requestId) => requestId
    ) as { tasks: Array<{ state: { blocked: { detail: string } } }> };

    expect(result.tasks[0]?.state.blocked.detail).toHaveLength(200);
  });

  it("strips the internal control prefix from a request id", () => {
    const result = sanitizePiInspection(inspection(), (requestId) =>
      requestId?.startsWith("open-inspect-control:")
        ? requestId.slice("open-inspect-control:".length)
        : requestId
    ) as { submissions: Array<{ requestId: string }> };

    expect(result.submissions[0]?.requestId).toBe("message-1");
    expect(JSON.stringify(result)).not.toContain("open-inspect-control:");
  });
});

describe("the blocked reason", () => {
  it("is null for a task that is not blocked", () => {
    expect(piBlockedReason({ kind: "running" })).toBeNull();
  });

  it("names an unknown reason rather than hiding it", () => {
    expect(piBlockedReason({ kind: "blocked" })).toEqual({ reason: "unknown" });
  });
});

describe("Pi 1.4 agent activity", () => {
  it("reports sleeping tasks without calling them active", () => {
    expect(piAgentActivityStatus([{ state: { kind: "sleeping" } }], 0, 0)).toBe("sleeping");
  });

  it("reports restart-limited tasks as parked", () => {
    expect(
      piAgentActivityStatus(
        [{ state: { kind: "blocked", reason: "restart_limit" } as never }],
        0,
        0
      )
    ).toBe("parked");
  });

  it("keeps runnable work ahead of sleeping and parked diagnostics", () => {
    expect(
      piAgentActivityStatus(
        [
          { state: { kind: "sleeping" } },
          { state: { kind: "blocked", reason: "restart_limit" } as never },
          { state: { kind: "ready" } },
        ],
        0,
        0
      )
    ).toBe("active");
  });
});

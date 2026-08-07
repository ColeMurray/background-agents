import { describe, expect, expectTypeOf, it } from "vitest";
import {
  serverMessageSchema,
  sessionBootstrapSchema,
  sessionDeltaSchema,
  sessionStatePatchSchema,
  viewRevisionSchema,
} from "./server-messages";
import type { PullRequestSummary, Session } from "./sessions";

describe("artifact_updated server message", () => {
  const artifact = {
    id: "artifact-1",
    type: "pr",
    url: "https://github.com/acme/web/pull/7",
    metadata: { number: 7, lifecycleState: "merged", isDraft: false },
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_005_000,
  };

  it("parses artifact_updated mirroring artifact_created", () => {
    const parsed = serverMessageSchema.parse({ type: "artifact_updated", artifact });
    expect(parsed.type).toBe("artifact_updated");
    if (parsed.type === "artifact_updated") {
      expect(parsed.artifact.id).toBe("artifact-1");
      expect(parsed.artifact.updatedAt).toBe(1_700_000_005_000);
    }
  });

  it("still parses artifact_created (rolling compatibility)", () => {
    const parsed = serverMessageSchema.parse({ type: "artifact_created", artifact });
    expect(parsed.type).toBe("artifact_created");
  });

  it("rejects artifact_updated without an artifact", () => {
    expect(serverMessageSchema.safeParse({ type: "artifact_updated" }).success).toBe(false);
  });
});

describe("Session.pullRequestSummary contract", () => {
  it("is optional on the session list contract and counts by display status", () => {
    expectTypeOf<Session["pullRequestSummary"]>().toEqualTypeOf<PullRequestSummary | undefined>();
    const summary: PullRequestSummary = { total: 2, open: 1, draft: 0, merged: 1, closed: 0 };
    expect(summary.total).toBe(2);
  });
});

const bootstrapState = {
  id: "session-1",
  title: "Inspect session",
  repoOwner: "acme",
  repoName: "web",
  baseBranch: "main",
  branchName: "inspect/session-1",
  status: "active",
  sandboxStatus: "ready",
  messageCount: 1,
  createdAt: 1_700_000_000_000,
};

describe("session view contracts", () => {
  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid revision %s", (revision) => {
    expect(viewRevisionSchema.safeParse(revision).success).toBe(false);
  });

  it("parses a bootstrap and removes access credentials", () => {
    const parsed = sessionBootstrapSchema.parse({
      sessionId: "session-1",
      viewRevision: 3,
      state: {
        ...bootstrapState,
        codeServerPassword: "secret",
        ttydToken: "secret",
      },
      artifacts: [],
      replay: {
        events: [
          {
            eventId: "event-1",
            timelineSequence: 1,
            event: { type: "ready", sandboxId: "sandbox-1", timestamp: 1 },
          },
          { eventId: "future-event", timelineSequence: 2, event: { type: "future" } },
        ],
        hasMore: false,
        cursor: null,
      },
    });

    expect(parsed.state).not.toHaveProperty("codeServerPassword");
    expect(parsed.state).not.toHaveProperty("ttydToken");
    expect(parsed.replay.events.map((item) => item.eventId)).toEqual(["event-1"]);
  });

  it("accepts strict state, event, and artifact operations", () => {
    expect(
      sessionDeltaSchema.parse({
        operations: [
          { type: "state_patch", patch: { title: "Updated", isProcessing: true } },
          {
            type: "event_upsert",
            item: {
              eventId: "event-1",
              timelineSequence: 1,
              event: { type: "ready", sandboxId: "sandbox-1", timestamp: 1 },
            },
          },
          {
            type: "artifact_upsert",
            artifact: {
              id: "artifact-1",
              type: "screenshot",
              url: "https://example.com/screenshot.png",
              metadata: null,
              createdAt: 1,
            },
          },
        ],
      }).operations
    ).toHaveLength(3);
  });

  it("rejects immutable and secret state patch fields", () => {
    expect(sessionStatePatchSchema.safeParse({ id: "session-2" }).success).toBe(false);
    expect(sessionStatePatchSchema.safeParse({ ttydToken: "secret" }).success).toBe(false);
    expect(sessionDeltaSchema.safeParse({ operations: [] }).success).toBe(false);
  });

  it.each([
    { type: "session_sync_started", mode: "resume", targetRevision: 3 },
    {
      type: "session_delta",
      revision: 3,
      delta: { operations: [{ type: "state_patch", patch: { status: "completed" } }] },
    },
    {
      type: "session_snapshot",
      bootstrap: {
        sessionId: "session-1",
        viewRevision: 3,
        state: bootstrapState,
        artifacts: [],
        replay: { events: [], hasMore: false, cursor: null },
      },
    },
    {
      type: "session_history_page",
      items: [
        {
          eventId: "event-1",
          timelineSequence: 1,
          event: { type: "ready", sandboxId: "sandbox-1", timestamp: 1 },
        },
      ],
      hasMore: false,
      cursor: null,
    },
    {
      type: "session_ready",
      sessionId: "session-1",
      participantId: "participant-1",
      appliedRevision: 3,
    },
    { type: "session_access_changed" },
  ])("parses V2 server message $type", (message) => {
    expect(serverMessageSchema.safeParse(message).success).toBe(true);
  });
});

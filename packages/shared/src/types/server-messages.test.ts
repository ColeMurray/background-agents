import { describe, expect, expectTypeOf, it } from "vitest";
import { serverMessageSchema, sessionBootstrapSchema } from "./server-messages";
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
  it("parses a bootstrap and removes access credentials", () => {
    const parsed = sessionBootstrapSchema.parse({
      sessionId: "session-1",
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

  it("rejects mismatched bootstrap identity and malformed stable event envelopes", () => {
    const bootstrap = {
      sessionId: "session-1",
      state: bootstrapState,
      artifacts: [],
      replay: { events: [], hasMore: false, cursor: null },
    };
    expect(
      sessionBootstrapSchema.safeParse({ ...bootstrap, sessionId: "different-session" }).success
    ).toBe(false);
    expect(
      sessionBootstrapSchema.safeParse({
        ...bootstrap,
        replay: {
          events: [{ timelineSequence: 1, event: { type: "future" } }],
          hasMore: false,
          cursor: null,
        },
      }).success
    ).toBe(false);
  });

  it("rejects a subscribed snapshot for a different session", () => {
    expect(
      serverMessageSchema.safeParse({
        type: "subscribed",
        sessionId: "different-session",
        state: bootstrapState,
        artifacts: [],
        participantId: "participant-1",
        replay: { events: [], hasMore: false, cursor: null },
      }).success
    ).toBe(false);
  });
});

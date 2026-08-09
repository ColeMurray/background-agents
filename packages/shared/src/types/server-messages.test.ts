import { describe, expect, it } from "vitest";
import { serverMessageSchema, sessionSnapshotSchema } from "./server-messages";

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

describe("VNC session protocol", () => {
  it("preserves the VNC URL but strips its credential from subscribed state", () => {
    const parsed = serverMessageSchema.parse({
      type: "subscribed",
      session: {
        id: "session-1",
        title: null,
        repoOwner: "acme",
        repoName: "web",
        baseBranch: "main",
        branchName: null,
        status: "active",
        sandboxStatus: "ready",
        messageCount: 0,
        createdAt: 1,
        vncUrl: "https://desktop.example",
        vncPassword: "secret",
      },
      artifacts: [],
      participantId: "participant-1",
      timeline: { events: [], hasMore: false, cursor: null },
    });

    expect(parsed).toMatchObject({ session: { vncUrl: "https://desktop.example" } });
    expect(parsed.session).not.toHaveProperty("vncPassword");
  });

  it("rejects VNC credentials on the WebSocket protocol", () => {
    expect(
      serverMessageSchema.safeParse({
        type: "vnc_info",
        url: "https://desktop.example",
        password: "secret",
      }).success
    ).toBe(false);
  });
});

const snapshotState = {
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
  it("parses a snapshot and removes access credentials", () => {
    const parsed = sessionSnapshotSchema.parse({
      session: {
        ...snapshotState,
        codeServerPassword: "secret",
        vncPassword: "secret",
        ttydToken: "secret",
      },
      artifacts: [],
      timeline: {
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

    expect(parsed.session).not.toHaveProperty("codeServerPassword");
    expect(parsed.session).not.toHaveProperty("vncPassword");
    expect(parsed.session).not.toHaveProperty("ttydToken");
    expect(parsed.timeline.events.map((item) => item.eventId)).toEqual(["event-1"]);
  });

  it("rejects malformed stable event envelopes", () => {
    const snapshot = {
      session: snapshotState,
      artifacts: [],
      timeline: { events: [], hasMore: false, cursor: null },
    };
    expect(
      sessionSnapshotSchema.safeParse({
        ...snapshot,
        timeline: {
          events: [{ timelineSequence: 1, event: { type: "future" } }],
          hasMore: false,
          cursor: null,
        },
      }).success
    ).toBe(false);
  });
});

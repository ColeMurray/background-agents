import { describe, expect, it } from "vitest";
import {
  redactSessionSnapshotSandboxAccess,
  serverMessageSchema,
  sessionSnapshotSchema,
} from "./server-messages";

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
      promptQueue: [],
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
      promptQueue: [],
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

  it("redacts sandbox locations without mutating the source snapshot", () => {
    const snapshot = sessionSnapshotSchema.parse({
      session: {
        ...snapshotState,
        codeServerUrl: "https://code.example",
        vncUrl: "https://vnc.example",
        ttydUrl: "https://terminal.example",
        tunnelUrls: { "3000": "https://app.example" },
        sandboxDashboardUrl: "https://provider.example",
      },
      artifacts: [],
      promptQueue: [],
      timeline: { events: [], hasMore: false, cursor: null },
    });

    const redacted = redactSessionSnapshotSandboxAccess(snapshot);

    expect(redacted.session).not.toHaveProperty("codeServerUrl");
    expect(redacted.session).not.toHaveProperty("vncUrl");
    expect(redacted.session).not.toHaveProperty("ttydUrl");
    expect(redacted.session).not.toHaveProperty("tunnelUrls");
    expect(redacted.session).not.toHaveProperty("sandboxDashboardUrl");
    expect(snapshot.session.codeServerUrl).toBe("https://code.example");
  });

  it("rejects malformed stable event envelopes", () => {
    const snapshot = {
      session: snapshotState,
      artifacts: [],
      promptQueue: [],
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

  it("parses authoritative prompt queues in snapshots and live updates", () => {
    const promptQueue = [
      {
        messageId: "message-running",
        content: "Run this",
        status: "processing",
      },
      {
        messageId: "message-pending",
        content: "Then this",
        status: "pending",
      },
    ];

    expect(
      sessionSnapshotSchema.parse({
        session: snapshotState,
        artifacts: [],
        timeline: { events: [], hasMore: false, cursor: null },
        promptQueue,
      }).promptQueue
    ).toEqual(promptQueue);
    expect(
      serverMessageSchema.parse({ type: "prompt_queue_updated", promptQueue }).promptQueue
    ).toEqual(promptQueue);
  });

  it("echoes prompt request correlation", () => {
    expect(
      serverMessageSchema.parse({
        type: "prompt_queued",
        clientRequestId: "request-1",
        messageId: "message-1",
        position: 2,
      })
    ).toMatchObject({ clientRequestId: "request-1" });
    expect(
      serverMessageSchema.parse({
        type: "prompt_queued",
        clientRequestId: "request-complete",
        messageId: "message-complete",
        position: null,
      })
    ).toMatchObject({ position: null });
    expect(
      serverMessageSchema.parse({
        type: "prompt_cancelled",
        clientRequestId: "request-cancel",
        messageId: "message-1",
      })
    ).toMatchObject({ clientRequestId: "request-cancel", messageId: "message-1" });
    expect(
      serverMessageSchema.safeParse({
        type: "prompt_queued",
        messageId: "message-1",
        position: 1,
      }).success
    ).toBe(false);
  });

  it("parses correlated prompt rejections", () => {
    expect(
      serverMessageSchema.parse({
        type: "error",
        code: "PROMPT_QUEUE_FULL",
        message: "Queue full",
        clientRequestId: "request-1",
      })
    ).toMatchObject({ clientRequestId: "request-1" });
  });
});

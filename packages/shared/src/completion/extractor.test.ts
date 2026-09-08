import { describe, expect, it } from "vitest";
import {
  buildAgentResponseFromEvents,
  extractAgentResponse,
  toArtifactType,
  toEventArtifactInfo,
  type ControlPlaneFetcher,
} from "./extractor";

describe("completion artifact type narrowing", () => {
  it("recognizes video artifacts", () => {
    expect(toArtifactType("video")).toBe("video");
  });

  it("keeps video artifacts out of public completion artifact links", () => {
    expect(toEventArtifactInfo({ artifactType: "video", url: "sessions/s1/media/a1.mp4" })).toBe(
      null
    );
  });
});

describe("buildAgentResponseFromEvents", () => {
  it("aggregates final text, tool calls, artifacts, and completion status", () => {
    const response = buildAgentResponseFromEvents(
      [
        {
          id: "complete:old",
          type: "execution_complete",
          data: { success: false, error: "old failure" },
          messageId: "msg-1",
          createdAt: 5,
        },
        {
          id: "complete:1",
          type: "execution_complete",
          data: { success: true },
          messageId: "msg-1",
          createdAt: 40,
        },
        {
          id: "token:new",
          type: "token",
          data: { content: "done" },
          messageId: "msg-1",
          createdAt: 30,
        },
        {
          id: "tool:2",
          type: "tool_call",
          data: { tool: "Read", args: { file_path: "README.md" } },
          messageId: "msg-1",
          createdAt: 25,
        },
        {
          id: "token:old",
          type: "token",
          data: { content: "partial" },
          messageId: "msg-1",
          createdAt: 10,
        },
        {
          id: "tool:1",
          type: "tool_call",
          data: { tool: "Bash", args: { command: "npm test" } },
          messageId: "msg-1",
          createdAt: 20,
        },
      ],
      [
        {
          type: "branch",
          url: "https://example.com/tree/fix",
          label: "Branch: fix",
          metadata: { head: "fix" },
        },
      ]
    );

    expect(response).toEqual({
      textContent: "done",
      toolCalls: [
        { tool: "Bash", summary: "Ran: npm test" },
        { tool: "Read", summary: "Read README.md" },
      ],
      artifacts: [
        {
          type: "branch",
          url: "https://example.com/tree/fix",
          label: "Branch: fix",
          metadata: { head: "fix" },
        },
      ],
      mediaArtifacts: [],
      success: true,
      error: undefined,
    });
  });

  it("extracts and deduplicates message-scoped media alongside linked artifacts", () => {
    const response = buildAgentResponseFromEvents([
      {
        id: "artifact:image",
        type: "artifact",
        data: {
          artifactType: "screenshot",
          artifactId: "image-1",
          url: "sessions/s1/media/image-1.png",
          metadata: {
            mimeType: "image/png",
            sizeBytes: 1234,
            caption: "Revenue by month",
          },
        },
        messageId: "msg-1",
        createdAt: 10,
      },
      {
        id: "artifact:image-duplicate",
        type: "artifact",
        data: {
          artifactType: "screenshot",
          artifactId: "image-1",
          url: "sessions/s1/media/image-1.png",
        },
        messageId: "msg-1",
        createdAt: 11,
      },
      {
        id: "artifact:pr",
        type: "artifact",
        data: {
          artifactType: "pr",
          url: "https://example.com/pull/1",
          metadata: { number: 1 },
        },
        messageId: "msg-1",
        createdAt: 12,
      },
      {
        id: "artifact:video",
        type: "artifact",
        data: {
          artifactType: "video",
          artifactId: "video-1",
          url: "sessions/s1/media/video-1.mp4",
          metadata: { mimeType: "video/mp4", sizeBytes: 4321, caption: "Demo" },
        },
        messageId: "msg-1",
        createdAt: 13,
      },
    ]);

    expect(response.artifacts).toEqual([
      {
        type: "pr",
        url: "https://example.com/pull/1",
        label: "PR #1",
      },
    ]);
    expect(response.mediaArtifacts).toEqual([
      {
        id: "image-1",
        type: "screenshot",
        mimeType: "image/png",
        sizeBytes: 1234,
        caption: "Revenue by month",
      },
      {
        id: "video-1",
        type: "video",
        mimeType: "video/mp4",
        sizeBytes: 4321,
        caption: "Demo",
      },
    ]);
  });

  it("ignores media events without a downloadable artifact id", () => {
    const response = buildAgentResponseFromEvents([
      {
        id: "artifact:legacy",
        type: "artifact",
        data: {
          artifactType: "screenshot",
          url: "sessions/s1/media/legacy.png",
        },
        messageId: "msg-1",
        createdAt: 1,
      },
    ]);

    expect(response.mediaArtifacts).toEqual([]);
  });

  it("omits invalid media sizes from extracted metadata", () => {
    for (const sizeBytes of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const response = buildAgentResponseFromEvents([
        {
          id: `artifact:${sizeBytes}`,
          type: "artifact",
          data: {
            artifactType: "screenshot",
            artifactId: `image-${sizeBytes}`,
            url: "sessions/s1/media/image.png",
            metadata: { sizeBytes },
          },
          messageId: "msg-1",
          createdAt: 1,
        },
      ]);

      expect(response.mediaArtifacts[0]).not.toHaveProperty("sizeBytes");
    }
  });

  it("uses the explicit default success only when completion success is absent", () => {
    expect(buildAgentResponseFromEvents([], [], { defaultSuccess: true }).success).toBe(true);
    expect(
      buildAgentResponseFromEvents(
        [
          {
            id: "complete:1",
            type: "execution_complete",
            data: { success: false },
            messageId: "msg-1",
            createdAt: 1,
          },
        ],
        [],
        { defaultSuccess: true }
      ).success
    ).toBe(false);
  });

  it("prefers message-scoped artifact events over supplied session artifacts", () => {
    const response = buildAgentResponseFromEvents(
      [
        {
          id: "artifact:current",
          type: "artifact",
          data: {
            artifactType: "branch",
            url: "https://example.com/tree/current",
            metadata: { name: "current" },
          },
          messageId: "msg-1",
          createdAt: 1,
        },
      ],
      [
        {
          type: "branch",
          url: "https://example.com/tree/old",
          label: "Branch: old",
        },
      ]
    );

    expect(response.artifacts).toEqual([
      {
        type: "branch",
        url: "https://example.com/tree/current",
        label: "Branch: current",
      },
    ]);
  });
});

describe("extractAgentResponse", () => {
  it("filters fetched session artifacts to the message event window", async () => {
    const fetcher: ControlPlaneFetcher = {
      async fetch(input) {
        const url = String(input);
        if (url.includes("/events")) {
          return Response.json({
            events: [
              {
                id: "token:msg-1",
                type: "token",
                data: { content: "done" },
                messageId: "msg-1",
                createdAt: 100,
              },
              {
                id: "complete:msg-1",
                type: "execution_complete",
                data: { success: true },
                messageId: "msg-1",
                createdAt: 200,
              },
            ],
            hasMore: false,
          });
        }

        if (url.includes("/artifacts")) {
          return Response.json({
            artifacts: [
              {
                id: "artifact-old",
                type: "branch",
                url: "https://example.com/tree/old",
                metadata: { head: "old" },
                createdAt: 50,
              },
              {
                id: "artifact-current",
                type: "branch",
                url: "https://example.com/tree/current",
                metadata: { head: "current" },
                createdAt: 150,
              },
            ],
          });
        }

        return Response.json({}, { status: 404 });
      },
    };

    const response = await extractAgentResponse(
      { fetcher, auth: { service: "slack-bot", secret: "test-secret" } },
      "session-1",
      "msg-1"
    );

    expect(response.artifacts).toEqual([
      {
        type: "branch",
        url: "https://example.com/tree/current",
        label: "Branch: current",
        metadata: { head: "current" },
      },
    ]);
  });
});

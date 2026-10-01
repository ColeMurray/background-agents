import { describe, expect, it } from "vitest";
import { verifyServiceSignature, sha256Hex } from "../service-auth";
import {
  buildAgentResponseFromEvents,
  extractAgentResponse,
  ProtectedReadError,
  summarizeToolCall,
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

  it.each([null, undefined, ["main"], "main", 42])(
    "ignores malformed metadata while preserving artifact labels: %s",
    (metadata) => {
      expect(
        toEventArtifactInfo({ artifactType: "branch", metadata, url: "/branches/main" })
      ).toEqual({ type: "branch", url: "/branches/main", label: "Branch: branch" });
      expect(toEventArtifactInfo({ artifactType: "pr", metadata, url: "/pull/1" })).toEqual({
        type: "pr",
        url: "/pull/1",
        label: "Pull Request",
      });
    }
  );

  it.each([null, undefined, ["README.md"], "README.md", 42])(
    "falls back to display defaults for malformed tool arguments: %s",
    (args) => {
      expect(summarizeToolCall({ tool: "Read", args })).toEqual({
        tool: "Read",
        summary: "Read file",
      });
      expect(summarizeToolCall({ tool: "Bash", args })).toEqual({
        tool: "Bash",
        summary: "Ran: ",
      });
    }
  );
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
  it.each([undefined, "slack-post"] as const)(
    "signs channel and optional purpose on all reads: %s",
    async (readPurpose) => {
      const urls: URL[] = [];
      const fetcher: ControlPlaneFetcher = {
        async fetch(input, init) {
          const url = new URL(String(input));
          urls.push(url);
          const headers = new Headers(init?.headers);
          expect(
            await verifyServiceSignature({
              signatureHeader: headers.get("X-OpenInspect-Service-Signature")!,
              service: "slack-bot",
              secret: "test-secret",
              method: "GET",
              url: url.toString(),
              bodySha256Hex: await sha256Hex(""),
              actor: "",
            })
          ).toMatchObject({ ok: true });
          expect(url.searchParams.get("channel")).toBe("slack:C123");
          expect(url.searchParams.get("purpose")).toBe(readPurpose ?? null);
          if (url.pathname.endsWith("/events")) {
            return Response.json({
              events: [],
              hasMore: !url.searchParams.has("cursor"),
              cursor: "next",
            });
          }
          return Response.json({ artifacts: [] });
        },
      };
      await extractAgentResponse(
        { fetcher, auth: { service: "slack-bot", secret: "test-secret" }, readPurpose },
        "s1",
        "m1",
        "trace",
        "slack:C123"
      );
      expect(urls).toHaveLength(3);
    }
  );

  it.each([
    ["events", "403"],
    ["events", "404"],
    ["events", "503"],
    ["events", "malformed"],
    ["events", "network"],
    ["events", "invalid-JSON"],
    ["artifacts", "403"],
    ["artifacts", "404"],
    ["artifacts", "503"],
    ["artifacts", "malformed"],
    ["artifacts", "network"],
    ["artifacts", "invalid-JSON"],
  ] as const)(
    "rejects protected %s %s failures without returning collected secret content",
    async (endpoint, failure) => {
      const fetcher: ControlPlaneFetcher = {
        async fetch(input) {
          const url = new URL(String(input));
          if (url.pathname.endsWith(`/${endpoint}`)) {
            if (failure === "network") throw new Error("read unavailable");
            if (failure === "invalid-JSON") return new Response("{");
            return /^\d+$/.test(failure)
              ? Response.json({ error: "read failed" }, { status: Number(failure) })
              : Response.json({ invalid: true });
          }
          return Response.json({
            events: [
              {
                id: "secret",
                type: "token",
                data: { content: "SECRET CONTENT" },
                messageId: "m1",
                createdAt: 1,
              },
            ],
            hasMore: false,
          });
        },
      };
      const extraction = extractAgentResponse(
        {
          fetcher,
          auth: { service: "slack-bot", secret: "test-secret" },
          readPurpose: "slack-post",
        },
        "s1",
        "m1",
        undefined,
        "slack:C1"
      );
      await expect(extraction).rejects.toBeInstanceOf(ProtectedReadError);
      await expect(extraction).rejects.toMatchObject({
        kind: failure === "403" || failure === "404" ? "denied" : "unavailable",
      });
    }
  );

  it.each([403, 404, 503])(
    "rejects a later event page status %s instead of returning earlier secret content",
    async (status) => {
      const fetcher: ControlPlaneFetcher = {
        async fetch(input) {
          const url = new URL(String(input));
          return url.searchParams.has("cursor")
            ? Response.json({}, { status })
            : Response.json({
                events: [
                  {
                    id: "secret",
                    type: "token",
                    data: { content: "SECRET CONTENT" },
                    messageId: "m1",
                    createdAt: 1,
                  },
                ],
                hasMore: true,
                cursor: "next",
              });
        },
      };
      await expect(
        extractAgentResponse(
          {
            fetcher,
            auth: { service: "slack-bot", secret: "test-secret" },
            readPurpose: "slack-post",
          },
          "s1",
          "m1",
          undefined,
          "slack:C1"
        )
      ).rejects.toMatchObject({ kind: status === 503 ? "unavailable" : "denied" });
    }
  );

  it.each(["403", "404", "503", "network", "malformed", "invalid-JSON"])(
    "keeps Linear's unprotected artifact fallback unchanged for %s",
    async (failure) => {
      const fetcher: ControlPlaneFetcher = {
        async fetch(input) {
          const url = new URL(String(input));
          expect(url.searchParams.has("purpose")).toBe(false);
          if (url.pathname.endsWith("/artifacts")) {
            if (failure === "network") throw new Error("read unavailable");
            if (failure === "invalid-JSON") return new Response("{");
            return /^\d+$/.test(failure)
              ? Response.json({}, { status: Number(failure) })
              : Response.json({ invalid: true });
          }
          return Response.json({
            events: [
              {
                id: "text",
                type: "token",
                data: { content: "Legacy response" },
                messageId: "m1",
                createdAt: 1,
              },
              {
                id: "branch",
                type: "artifact",
                data: {
                  artifactType: "branch",
                  url: "https://example.com/tree/legacy",
                  metadata: { name: "legacy" },
                },
                messageId: "m1",
                createdAt: 2,
              },
            ],
            hasMore: false,
          });
        },
      };
      expect(
        await extractAgentResponse(
          { fetcher, auth: { service: "linear-bot", secret: "test-secret" } },
          "s1",
          "m1"
        )
      ).toMatchObject({
        textContent: "Legacy response",
        artifacts: [
          { type: "branch", url: "https://example.com/tree/legacy", label: "Branch: legacy" },
        ],
      });
    }
  );

  it("rejects protected pagination that omits the continuation cursor", async () => {
    const fetcher: ControlPlaneFetcher = {
      async fetch() {
        return Response.json({ events: [], hasMore: true });
      },
    };
    await expect(
      extractAgentResponse(
        {
          fetcher,
          auth: { service: "slack-bot", secret: "test-secret" },
          readPurpose: "slack-post",
        },
        "s1",
        "m1",
        undefined,
        "slack:C1"
      )
    ).rejects.toMatchObject({ kind: "unavailable", message: "Invalid events response" });
  });

  it("returns a failed response when the events response is malformed", async () => {
    const fetcher: ControlPlaneFetcher = {
      async fetch() {
        return Response.json({ events: [{ id: "event-1", type: "token" }], hasMore: false });
      },
    };

    await expect(
      extractAgentResponse(
        { fetcher, auth: { service: "slack-bot", secret: "test-secret" } },
        "session-1",
        "msg-1"
      )
    ).resolves.toEqual({
      textContent: "",
      toolCalls: [],
      artifacts: [],
      mediaArtifacts: [],
      success: false,
    });
  });

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

  it("ignores a malformed artifacts response", async () => {
    const fetcher: ControlPlaneFetcher = {
      async fetch(input) {
        const url = String(input);
        if (url.includes("/events")) {
          return Response.json({
            events: [
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

        return Response.json({ artifacts: [{ id: "artifact-1", type: "branch" }] });
      },
    };

    const response = await extractAgentResponse(
      { fetcher, auth: { service: "slack-bot", secret: "test-secret" } },
      "session-1",
      "msg-1"
    );

    expect(response).toMatchObject({ success: true, artifacts: [] });
  });
});

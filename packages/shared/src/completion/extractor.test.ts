import { describe, expect, it } from "vitest";
import { verifyServiceSignature, sha256Hex } from "../service-auth";
import type { EventResponse } from "../types/sandbox-events";
import { getResponseFileArtifacts } from "../types/artifacts";
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
      fileArtifacts: [],
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
      const requests: { url: URL; headers: Headers }[] = [];
      const fetcher: ControlPlaneFetcher = {
        async fetch(input, init) {
          const url = new URL(String(input));
          requests.push({ url, headers: new Headers(init?.headers) });
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
      expect(requests.map(({ url }) => url.pathname)).toEqual([
        "/sessions/s1/events",
        "/sessions/s1/events",
        "/sessions/s1/artifacts",
      ]);
      expect(requests[1]?.url.searchParams.get("cursor")).toBe("next");
      for (const { url, headers } of requests) {
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
      }
    }
  );

  it.each([
    ["events", "403", false],
    ["events", "404", false],
    ["events", "503", false],
    ["events", "malformed", false],
    ["events", "network", false],
    ["events", "invalid-JSON", false],
    ["events", "403", true],
    ["events", "404", true],
    ["events", "503", true],
    ["events", "missing-cursor", false],
    ["artifacts", "403", false],
    ["artifacts", "404", false],
    ["artifacts", "503", false],
    ["artifacts", "malformed", false],
    ["artifacts", "network", false],
    ["artifacts", "invalid-JSON", false],
  ] as const)(
    "rejects protected %s %s failures (later page: %s) without returning collected content",
    async (endpoint, failure, laterPage) => {
      const urls: URL[] = [];
      const fetcher: ControlPlaneFetcher = {
        async fetch(input) {
          const url = new URL(String(input));
          urls.push(url);
          if (
            url.pathname.endsWith(`/${endpoint}`) &&
            (!laterPage || url.searchParams.has("cursor"))
          ) {
            if (failure === "network") throw new Error("read unavailable");
            if (failure === "invalid-JSON") return new Response("{");
            if (failure === "missing-cursor") return Response.json({ events: [], hasMore: true });
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
            hasMore: laterPage,
            cursor: "next",
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
        ...(failure === "missing-cursor" ? { message: "Invalid events response" } : {}),
      });
      expect(urls).toHaveLength(laterPage || endpoint === "artifacts" ? 2 : 1);
      expect(urls.at(-1)?.pathname).toBe(`/sessions/s1/${endpoint}`);
      expect(urls.at(-1)?.searchParams.get("cursor")).toBe(laterPage ? "next" : null);
    }
  );

  it.each(["403", "network", "malformed", "invalid-JSON"])(
    "keeps Linear's unprotected artifact fallback unchanged for %s",
    async (failure) => {
      const fetcher: ControlPlaneFetcher = {
        async fetch(input) {
          const url = new URL(String(input));
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
      fileArtifacts: [],
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

describe("generated file completion extraction", () => {
  const metadata = {
    objectKey: "sessions/s1/files/f1",
    filename: "report.csv",
    mimeType: "text/csv",
    sizeBytes: 12,
    messageId: "m1",
    caption: "Requested report",
  };
  function fileEvent(overrides: Partial<EventResponse> = {}): EventResponse {
    return {
      id: "event:f1",
      type: "artifact",
      data: { artifactType: "file", artifactId: "f1", url: metadata.objectKey, metadata },
      messageId: "m1",
      createdAt: 20,
      ...overrides,
    };
  }

  it("orders a deduplicated mixed batch and derives the legacy media projection", () => {
    const image: EventResponse = {
      id: "event:image",
      type: "artifact",
      messageId: "m1",
      createdAt: 10,
      data: {
        artifactType: "screenshot",
        artifactId: "image",
        metadata: { mimeType: "image/png" },
      },
    };
    const video: EventResponse = {
      id: "event:video",
      type: "artifact",
      messageId: "m1",
      createdAt: 30,
      data: { artifactType: "video", artifactId: "video" },
    };
    const response = buildAgentResponseFromEvents([
      video,
      fileEvent({ id: "duplicate", createdAt: 40 }),
      fileEvent(),
      image,
    ]);
    expect(response.fileArtifacts).toEqual([
      { id: "image", type: "screenshot", mimeType: "image/png" },
      { id: "f1", type: "file", available: true, metadata },
      { id: "video", type: "video" },
    ]);
    expect(response.mediaArtifacts).toEqual([
      { id: "image", type: "screenshot", mimeType: "image/png" },
      { id: "video", type: "video" },
    ]);
    expect(getResponseFileArtifacts(response)).toHaveLength(3);
    expect(response.artifacts).toEqual([]);
  });

  it("recovers a later validated file without changing its original chronological position", () => {
    const invalid = fileEvent({ id: "invalid", createdAt: 10 });
    invalid.data.metadata = null;
    const valid = fileEvent({ id: "valid", createdAt: 30 });
    const laterInvalid = fileEvent({ id: "later-invalid", createdAt: 40 });
    laterInvalid.data.metadata = null;
    const media: EventResponse = {
      id: "media",
      type: "artifact",
      messageId: "m1",
      createdAt: 20,
      data: { artifactType: "screenshot", artifactId: "image" },
    };
    const response = buildAgentResponseFromEvents([laterInvalid, valid, media, invalid]);
    expect(response.fileArtifacts).toEqual([
      { id: "f1", type: "file", available: true, metadata },
      { id: "image", type: "screenshot" },
    ]);
    expect(response.mediaArtifacts).toEqual([{ id: "image", type: "screenshot" }]);
  });

  it.each([
    null,
    { ...metadata, sizeBytes: 0 },
    { ...metadata, filename: "../report.csv" },
    { ...metadata, mimeType: "image/png" },
    { ...metadata, messageId: "older-message" },
    { ...metadata, objectKey: "sessions/s1/files/other-file" },
  ])("retains an unavailable file when metadata is invalid or mismatched: %j", (badMetadata) => {
    const event = fileEvent();
    event.data.metadata = badMetadata;
    const response = buildAgentResponseFromEvents([event]);
    expect(response.fileArtifacts).toEqual([{ id: "f1", type: "file", available: false }]);
    expect(response.artifacts).toEqual([]);
    expect(response.mediaArtifacts).toEqual([]);
  });

  it("does not accept a different object URL or unattributed file event", () => {
    const event = fileEvent();
    event.data.url = "sessions/s2/files/f1";
    expect(buildAgentResponseFromEvents([event]).fileArtifacts).toEqual([
      { id: "f1", type: "file", available: false },
    ]);
    expect(buildAgentResponseFromEvents([fileEvent({ messageId: null })]).fileArtifacts).toEqual([
      { id: "f1", type: "file", available: false },
    ]);
  });

  it("excludes stored outputs from event and direct-list fallback links", () => {
    expect(toArtifactType("file")).toBe("file");
    expect(toArtifactType("unknown")).toBeNull();
    expect(toEventArtifactInfo(fileEvent().data)).toBeNull();
    const response = buildAgentResponseFromEvents(
      [],
      [
        { type: "file", url: metadata.objectKey, label: "file" },
        { type: "screenshot", url: "sessions/s1/media/image", label: "screenshot" },
        { type: "video", url: "sessions/s1/media/video", label: "video" },
        { type: "pr", url: "https://github.com/acme/repo/pull/1", label: "PR #1" },
      ]
    );
    expect(response.artifacts).toEqual([
      { type: "pr", url: "https://github.com/acme/repo/pull/1", label: "PR #1" },
    ]);
    expect(response.fileArtifacts).toEqual([]);
  });

  it("selects only the requested message's events, never session-wide files", async () => {
    const fetcher: ControlPlaneFetcher = {
      async fetch(input) {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/events")) {
          expect(url.searchParams.get("message_id")).toBe("m1");
          return Response.json({ events: [fileEvent()], hasMore: false });
        }
        return Response.json({
          artifacts: [
            { id: "f1", type: "file", url: metadata.objectKey, metadata, createdAt: 20 },
            {
              id: "older-file",
              type: "file",
              url: "sessions/s1/files/older-file",
              metadata: null,
              createdAt: 20,
            },
            {
              id: "pr",
              type: "pr",
              url: "https://github.com/acme/repo/pull/1",
              metadata: { number: 1 },
              createdAt: 20,
            },
          ],
        });
      },
    };
    const response = await extractAgentResponse(
      { fetcher, auth: { service: "slack-bot", secret: "secret" }, readPurpose: "slack-post" },
      "s1",
      "m1"
    );
    expect(response.fileArtifacts).toEqual([{ id: "f1", type: "file", available: true, metadata }]);
    expect(response.artifacts).toEqual([
      {
        type: "pr",
        url: "https://github.com/acme/repo/pull/1",
        label: "PR #1",
        metadata: { number: 1 },
      },
    ]);
  });
});

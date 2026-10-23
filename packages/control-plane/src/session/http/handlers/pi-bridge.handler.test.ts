import { expect, it, vi } from "vitest";
import { PiBridgeHandler } from "./pi-bridge.handler";
import type { PiPinnedRepository } from "../../../pi/repository-tools";

function harness(
  options: {
    claimedBaseline?: boolean;
    activeControl?: boolean;
    processingMessageId?: string;
    spawnSource?: "user" | "automation";
    claimedAttachment?: {
      id: string;
      mime_type: string;
      size_bytes: number;
      object_key: string;
      message_id: string | null;
      cleanup_claimed_at: number | null;
      created_at: number;
    };
    attachmentBytes?: Uint8Array;
    authorMayAct?: boolean;
    renderedMemory?: { rendered: string };
  } = {}
) {
  const fullSha = "a".repeat(40);
  const pin = vi.fn(async (): Promise<PiPinnedRepository[]> => []);
  const restore = vi.fn(() => [
    {
      repoOwner: "acme",
      repoName: "widgets",
      position: 0,
      baseBranch: "main",
      commitSha: fullSha,
    },
  ]);
  const claimBaselines = vi.fn();
  const prepareMaterialization = vi.fn(async () => ({
    version: 1 as const,
    repository: {
      position: 0,
      repoOwner: "acme",
      repoName: "widgets",
      commitSha: fullSha,
      root: "/workspace/repos/0",
    },
    files: [],
  }));
  const materializeBatch = vi.fn(async () => ({
    version: 1 as const,
    repository: {
      position: 0,
      repoOwner: "acme",
      repoName: "widgets",
      commitSha: fullSha,
      root: "/workspace/repos/0",
    },
    offset: 0,
    nextOffset: null,
    files: [],
  }));
  const agentControls = {
    handle: vi.fn(async (_request: Request) => Response.json({ state: "completed" })),
  };
  const authorMayAct = vi.fn(async () =>
    options.authorMayAct === false
      ? ({ kind: "denied", reason: "The turn author lost access" } as const)
      : ({ kind: "allowed" } as const)
  );
  const renderedContext = vi.fn(async () =>
    options.renderedMemory
      ? ({ schemaVersion: 1, manifestSha256: "manifest", ...options.renderedMemory } as const)
      : null
  );
  const handler = new PiBridgeHandler({
    sessions: {
      getPiFeatureCapabilitySnapshot: () => null,
      getSession: () =>
        ({
          harness: "pi",
          base_sha: options.claimedBaseline ? fullSha : null,
          spawn_source: options.spawnSource ?? "user",
        }) as never,
      getSessionRepositories: () =>
        [
          {
            position: 0,
            repoOwner: "acme",
            repoName: "widgets",
            isPrimary: true,
            row: { base_sha: options.claimedBaseline ? fullSha : null },
          },
        ] as never,
    },
    messages: {
      getProcessingMessage: () =>
        options.processingMessageId ? ({ id: options.processingMessageId } as never) : null,
      getMessageHumanActor: (messageId) => (messageId ? "user-1" : null),
    },
    controls: { isActiveOperation: () => options.activeControl === true },
    authorMayAct,
    agentControls,
    credentials: {
      getProviderAccess: vi.fn(async () => ({
        accessToken: "secret-token",
        expiresAt: Date.now() + 60_000,
        credentialVersion: 1,
      })),
    },
    skills: { getSandboxInstallation: vi.fn(async () => null) },
    attachments: {
      getClaimedByMessage: vi.fn((messageId: string, attachmentId: string) => {
        const row = options.claimedAttachment;
        if (!row || row.id !== attachmentId || row.message_id !== messageId) return null;
        return row;
      }),
    },
    media: {
      get: vi.fn(async (key: string) => {
        if (!options.claimedAttachment || options.claimedAttachment.object_key !== key) {
          return null;
        }
        const bytes = options.attachmentBytes ?? new Uint8Array([1, 2, 3]);
        return {
          size: bytes.byteLength,
          httpEtag: "etag",
          writeHttpMetadata: () => {},
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
        };
      }),
      put: vi.fn(),
      delete: vi.fn(),
      head: vi.fn(async () => null),
    },
    repositories: {
      pin,
      restore,
      list: vi.fn(),
      read: vi.fn(),
      prepareMaterialization,
      materializeBatch,
    },
    diffs: { claimBaselines },
    memory: { renderedContext },
    getSessionId: () => "session-1",
  });
  return {
    handler,
    pin,
    restore,
    claimBaselines,
    prepareMaterialization,
    materializeBatch,
    fullSha,
    agentControls,
    authorMayAct,
    renderedContext,
  };
}

it("reauthorizes and refetches rendered memory for every active turn request", async () => {
  const h = harness({
    processingMessageId: "message-1",
    authorMayAct: true,
    renderedMemory: { rendered: "# Current memory" },
  });
  const request = () =>
    new Request("http://session/internal/pi-context", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Pi-Operation-ID": "message-1" },
      body: JSON.stringify({ mode: "bootstrap" }),
    });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await h.handler.context(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      memory: { rendered: "# Current memory" },
    });
  }

  expect(h.authorMayAct).toHaveBeenCalledTimes(2);
  expect(h.renderedContext).toHaveBeenCalledTimes(2);
});

it("fails closed before rendering memory when the turn author loses authority", async () => {
  const h = harness({
    processingMessageId: "message-1",
    authorMayAct: false,
    renderedMemory: { rendered: "# Must not escape" },
  });

  const response = await h.handler.context(
    new Request("http://session/internal/pi-context", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Pi-Operation-ID": "message-1" },
      body: JSON.stringify({ mode: "bootstrap" }),
    })
  );

  expect(response.status).toBe(409);
  expect(h.renderedContext).not.toHaveBeenCalled();
});

it("authorizes a Code Mode run for the turn that owns it", async () => {
  const h = harness({ processingMessageId: "message-1" });

  const response = await h.handler.codeModeAuthorize(
    new Request("http://session/internal/pi-codemode/authorize", {
      method: "POST",
      headers: { "X-Pi-Operation-ID": "message-1" },
      body: JSON.stringify({}),
    })
  );

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ allowed: true });
});

it("refuses a Code Mode run with no turn behind it", async () => {
  const h = harness();

  const response = await h.handler.codeModeAuthorize(
    new Request("http://session/internal/pi-codemode/authorize", {
      method: "POST",
      body: JSON.stringify({}),
    })
  );

  expect(response.status).toBe(409);
});

const CLAIMED_ATTACHMENT = {
  id: "upload-1",
  mime_type: "image/png",
  size_bytes: 3,
  object_key: "sessions/session-1/attachments/upload-1",
  message_id: "message-1",
  cleanup_claimed_at: null,
  created_at: 1,
};

it("serves the bytes of an image the turn claimed", async () => {
  const { handler } = harness({
    processingMessageId: "message-1",
    claimedAttachment: CLAIMED_ATTACHMENT,
  });

  const response = await handler.attachment(
    new Request("http://session/internal/pi-attachment", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Pi-Operation-ID": "message-1" },
      body: JSON.stringify({ attachmentId: "upload-1" }),
    })
  );

  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("image/png");
  await expect(response.arrayBuffer()).resolves.toEqual(
    new Uint8Array([1, 2, 3]).buffer as ArrayBuffer
  );
});

it("refuses an image the turn did not claim", async () => {
  const { handler } = harness({
    processingMessageId: "message-1",
    claimedAttachment: { ...CLAIMED_ATTACHMENT, message_id: "message-2" },
  });

  const response = await handler.attachment(
    new Request("http://session/internal/pi-attachment", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Pi-Operation-ID": "message-1" },
      body: JSON.stringify({ attachmentId: "upload-1" }),
    })
  );

  expect(response.status).toBe(404);
});

it("refuses an image request with no turn behind it", async () => {
  const { handler } = harness({ claimedAttachment: CLAIMED_ATTACHMENT });

  const response = await handler.attachment(
    new Request("http://session/internal/pi-attachment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attachmentId: "upload-1" }),
    })
  );

  expect(response.status).toBe(409);
});

it("recognizes an accepted native control as active bridge authority", async () => {
  const { handler } = harness({ activeControl: true });
  const response = await handler.credential(
    new Request("http://session/internal/pi-credential", {
      headers: { "X-Pi-Operation-ID": "native-control-1" },
    })
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
});

it("routes bounded same-session agent controls through active SessionDO authority", async () => {
  const { handler, agentControls } = harness({ activeControl: true });
  const response = await handler.agentControl(
    new Request("http://session/internal/pi-agent-control", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Pi-Operation-ID": "message-1" },
      body: JSON.stringify({
        sessionId: "other-session",
        requestId: "agent-request-1",
        action: "follow_up",
        conversationId: 2,
        content: "focus",
      }),
    })
  );
  expect(response.status).toBe(200);
  const forwarded = agentControls.handle.mock.calls[0]?.[0];
  await expect(forwarded?.json()).resolves.toMatchObject({
    actorId: "pi:message-1",
    source: "pi",
    control: { sessionId: "session-1", action: "follow_up", conversationId: 2 },
  });
});

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { PiBridgeHandler } from "./pi-bridge.handler";
import { ExternalActionDefinitionRegistry } from "../../external-action-definitions";
import { SourceControlProviderError } from "../../../source-control";
import type { PiPinnedRepository } from "../../../pi/repository-tools";

function harness(
  options: {
    claimedBaseline?: boolean;
    activeControl?: boolean;
    processingMessageId?: string;
    spawnSource?: "user" | "automation";
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
  const handler = new PiBridgeHandler({
    sessions: {
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
    },
    controls: { isActiveOperation: () => options.activeControl === true },
    agentControls,
    credentials: {
      getOpenAIAccess: vi.fn(async () => ({
        accessToken: "secret-token",
        expiresAt: Date.now() + 60_000,
        credentialVersion: 1,
      })),
    },
    skills: { getSandboxInstallation: vi.fn(async () => null) },
    repositories: {
      pin,
      restore,
      list: vi.fn(),
      read: vi.fn(),
      prepareMaterialization,
      materializeBatch,
    },
    diffs: { claimBaselines },
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
  };
}

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
        action: "steer",
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
    control: { sessionId: "session-1", action: "steer", conversationId: 2 },
  });
});

it("advertises agent messaging only for explicitly allowed session origins", async () => {
  const user = harness({ spawnSource: "user" });
  const automation = harness({ spawnSource: "automation" });
  const request = () =>
    new Request("http://session/internal/pi-context", {
      method: "POST",
      body: JSON.stringify({ mode: "bootstrap" }),
    });
  await expect((await user.handler.context(request())).json()).resolves.toMatchObject({
    agentMessagingEnabled: true,
  });
  await expect((await automation.handler.context(request())).json()).resolves.toMatchObject({
    agentMessagingEnabled: false,
  });
});

function externalActionHarness(
  enabled: boolean,
  options: {
    approval?: {
      source: "automation_grant";
      actorId: string;
      grantId: string;
    };
    executor?: { execute: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> };
    definition?: boolean;
    liveMode?: () => "off" | "read_only" | "enabled";
    resolveAutomationApproval?: (
      provider: string,
      action: string
    ) => Promise<{ source: "automation_grant"; actorId: string; grantId: string } | undefined>;
    credentialAvailable?: (provider: string) => Promise<boolean>;
  } = {}
) {
  const base = harness();
  const gateway = {
    prepare: vi.fn(async () => ({ id: "action-1", state: "awaiting_approval" })),
    status: vi.fn(() => ({
      action: {
        id: "action-1",
        sessionId: "session-1",
        operationId: "message-1",
        provider: "fake",
        action: "publish_comment",
        state: "awaiting_approval",
        approval: options.approval ?? null,
      },
      history: [],
    })),
    execute: vi.fn(),
    approve: vi.fn(() => undefined),
    deny: vi.fn(() => undefined),
    cancel: vi.fn(() => undefined),
    expireDue: vi.fn(() => []),
    listPending: vi.fn(() => ({ actions: [], nextCursor: null })),
    isBoundToOperation: vi.fn(() => true),
    nextReconciliationAt: vi.fn(() => null),
  };
  const flushAudit = vi.fn(async () => undefined);
  const definitions = new ExternalActionDefinitionRegistry();
  if (options.definition !== false) {
    definitions.register({
      provider: "fake",
      action: "publish_comment",
      requestSchema: z.object({
        target: z.record(z.string(), z.json()),
        arguments: z.record(z.string(), z.json()),
      }),
      publicResultSchema: z.json() as never,
      executor: (options.executor ?? {
        execute: vi.fn(),
        status: vi.fn(),
      }) as never,
    });
  }
  const handler = new PiBridgeHandler({
    sessions: {
      getSession: () => ({ harness: "pi" }) as never,
      getSessionRepositories: () => [],
    },
    messages: { getProcessingMessage: () => ({ id: "message-1" }) as never },
    controls: { isActiveOperation: () => false },
    agentControls: { handle: vi.fn() },
    credentials: { getOpenAIAccess: vi.fn() },
    skills: { getSandboxInstallation: vi.fn(async () => null) },
    repositories: {
      pin: vi.fn(async () => []),
      restore: vi.fn(() => []),
      list: vi.fn(),
      read: vi.fn(),
      prepareMaterialization: vi.fn(),
      materializeBatch: vi.fn(),
    },
    diffs: { claimBaselines: vi.fn() },
    getSessionId: () => "session-1",
    externalActions: {
      enabled,
      gateway: gateway as never,
      definitions,
      liveMode: options.liveMode,
      credentialAvailable: options.credentialAvailable,
      resolveAutomationApproval: options.resolveAutomationApproval,
      flushAudit,
      nextDeadline: () => null,
    },
  });
  return { ...base, handler, gateway, flushAudit };
}

describe("PiBridgeHandler context", () => {
  it("lists a publication only for a provider the deployment holds a credential for", async () => {
    const credentialAvailable = vi.fn(async (provider: string) => provider === "fake");
    const h = externalActionHarness(true, { credentialAvailable });

    const response = await h.handler.context(
      new Request("http://session/internal/pi-context", {
        method: "POST",
        body: JSON.stringify({ mode: "bootstrap" }),
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      externalActions: [
        { provider: "fake", action: "publish_comment", toolName: "publish_fake_publish_comment" },
      ],
    });
    expect(credentialAvailable).toHaveBeenCalledWith("fake");
  });

  it("lists no publication when the deployment holds no credential", async () => {
    const h = externalActionHarness(true, { credentialAvailable: async () => false });

    const response = await h.handler.context(
      new Request("http://session/internal/pi-context", {
        method: "POST",
        body: JSON.stringify({ mode: "bootstrap" }),
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ externalActions: [] });
  });

  it("returns lightweight repository identities without resolving heads", async () => {
    const h = harness();

    const response = await h.handler.context(
      new Request("http://session/internal/pi-context", {
        method: "POST",
        body: JSON.stringify({}),
      })
    );

    expect(response.status).toBe(200);
    expect(h.pin).not.toHaveBeenCalled();
    expect(h.restore).not.toHaveBeenCalled();
    expect(h.claimBaselines).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      repositories: [
        {
          repoOwner: "acme",
          repoName: "widgets",
          position: 0,
          baseBranch: null,
        },
      ],
    });
  });

  it("resolves and claims repository heads only for an explicit lazy pin request", async () => {
    const h = harness({ processingMessageId: "message-1" });

    const response = await h.handler.context(
      new Request("http://session/internal/pi-context", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Pi-Operation-ID": "message-1",
        },
        body: JSON.stringify({ mode: "pin" }),
      })
    );

    expect(response.status).toBe(200);
    expect(h.pin).toHaveBeenCalledOnce();
    expect(h.claimBaselines).toHaveBeenCalledWith([]);
  });

  it("restores durable repository pins without resolving branch heads", async () => {
    const h = harness({ processingMessageId: "message-1" });
    const repositoryPins = [
      {
        repoOwner: "acme",
        repoName: "widgets",
        position: 0,
        commitSha: h.fullSha,
      },
    ];

    const response = await h.handler.context(
      new Request("http://session/internal/pi-context", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Pi-Operation-ID": "message-1",
        },
        body: JSON.stringify({ mode: "pin", repositoryPins }),
      })
    );

    expect(response.status).toBe(200);
    expect(h.restore).toHaveBeenCalledWith(repositoryPins);
    expect(h.pin).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      repositories: [expect.objectContaining({ commitSha: h.fullSha })],
    });
  });

  it("recovers SessionDO baselines after a crash before Pi persisted its pins", async () => {
    const h = harness({ claimedBaseline: true, processingMessageId: "message-1" });
    h.pin.mockResolvedValueOnce([
      {
        repoOwner: "acme",
        repoName: "widgets",
        position: 0,
        baseBranch: "main",
        commitSha: "b".repeat(40),
      },
    ]);

    const response = await h.handler.context(
      new Request("http://session/internal/pi-context", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Pi-Operation-ID": "message-1",
        },
        body: JSON.stringify({ mode: "pin" }),
      })
    );

    expect(response.status).toBe(200);
    expect(h.pin).not.toHaveBeenCalled();
    expect(h.restore).toHaveBeenCalledWith([
      {
        position: 0,
        repoOwner: "acme",
        repoName: "widgets",
        commitSha: h.fullSha,
      },
    ]);
    expect(h.claimBaselines).toHaveBeenCalledWith([
      expect.objectContaining({ baseSha: h.fullSha }),
    ]);
  });

  it("returns one credential-free materialization only for a Pi session", async () => {
    const h = harness({ claimedBaseline: true, processingMessageId: "message-1" });

    const response = await h.handler.repositoryMaterialization(
      new Request("http://session/internal/pi-repository-materialization", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Pi-Operation-ID": "message-1",
        },
        body: JSON.stringify({ operation: "manifest", repository: 0, commitSha: h.fullSha }),
      })
    );

    expect(response.status).toBe(200);
    expect(h.prepareMaterialization).toHaveBeenCalledWith({
      repository: 0,
      commitSha: h.fullSha,
    });
    expect(JSON.stringify(await response.json())).not.toMatch(/token|credential|authorization/i);
  });

  it("rejects materialization at a full SHA other than SessionDO's claimed baseline", async () => {
    const h = harness({ claimedBaseline: true });

    const response = await h.handler.repositoryMaterialization(
      new Request("http://session/internal/pi-repository-materialization", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operation: "manifest",
          repository: 0,
          commitSha: "b".repeat(40),
        }),
      })
    );

    expect(response.status).toBe(409);
    expect(h.prepareMaterialization).not.toHaveBeenCalled();
  });

  it("marks transient provider materialization failures as retryable", async () => {
    const h = harness({ claimedBaseline: true, processingMessageId: "message-1" });
    h.prepareMaterialization.mockRejectedValueOnce(
      new SourceControlProviderError("provider unavailable", "transient", 503)
    );

    const response = await h.handler.repositoryMaterialization(
      new Request("http://session/internal/pi-repository-materialization", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Pi-Operation-ID": "message-1",
        },
        body: JSON.stringify({ operation: "manifest", repository: 0, commitSha: h.fullSha }),
      })
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
  });
});

describe("PiBridgeHandler external actions", () => {
  const actionRequest = {
    toolCallId: "call-1",
    idempotencyKey: "pi:message-1:call-1",
    provider: "fake",
    action: "publish_comment",
    summary: "Publish comment",
    target: {},
    arguments: { body: "hello" },
  };

  it("fails closed before persistence while the capability is disabled", async () => {
    const h = externalActionHarness(false);
    const response = await h.handler.externalActionPrepare(
      new Request("http://session/internal/pi-external-action/prepare", {
        method: "POST",
        headers: { "X-Pi-Operation-ID": "message-1" },
        body: JSON.stringify(actionRequest),
      })
    );

    expect(response.status).toBe(404);
    expect(h.gateway.prepare).not.toHaveBeenCalled();
  });

  it("prepares and reads actions only for the active Pi operation", async () => {
    const h = externalActionHarness(true);
    const prepared = await h.handler.externalActionPrepare(
      new Request("http://session/internal/pi-external-action/prepare", {
        method: "POST",
        headers: { "X-Pi-Operation-ID": "message-1" },
        body: JSON.stringify(actionRequest),
      })
    );
    const read = await h.handler.externalActionStatus(
      new Request("http://session/internal/pi-external-action/status?actionId=action-1", {
        headers: { "X-Pi-Operation-ID": "message-1" },
      })
    );

    expect(prepared.status).toBe(200);
    expect(read.status).toBe(200);
    expect(h.gateway.prepare).toHaveBeenCalledWith(
      "session-1",
      "message-1",
      actionRequest,
      undefined,
      { expiresAt: expect.any(Number) }
    );
    expect(h.gateway.status).toHaveBeenCalledWith("action-1");
  });

  it("refuses execution when no provider executor is bound", async () => {
    const h = externalActionHarness(true, { definition: false });
    const response = await h.handler.externalActionExecute(
      new Request("http://session/internal/pi-external-action/execute", {
        method: "POST",
        headers: { "X-Pi-Operation-ID": "message-1" },
        body: JSON.stringify({ actionId: "action-1" }),
      })
    );

    expect(response.status).toBe(503);
    expect(h.gateway.execute).not.toHaveBeenCalled();
  });

  it("reauthorizes the exact automation grant at execution claim", async () => {
    const executor = { execute: vi.fn(), status: vi.fn() };
    const resolveAutomationApproval = vi.fn(async () => undefined);
    const h = externalActionHarness(true, {
      approval: {
        source: "automation_grant",
        actorId: "executor-1",
        grantId: "grant-1",
      },
      executor,
      resolveAutomationApproval,
    });
    const response = await h.handler.externalActionExecute(
      new Request("http://session/internal/pi-external-action/execute", {
        method: "POST",
        headers: { "X-Pi-Operation-ID": "message-1" },
        body: JSON.stringify({ actionId: "action-1" }),
      })
    );

    expect(response.status).toBe(409);
    expect(resolveAutomationApproval).toHaveBeenCalledWith("fake", "publish_comment");
    expect(h.gateway.execute).not.toHaveBeenCalled();
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("lets an authenticated human approve and inspect a prepared action", async () => {
    const h = externalActionHarness(true);
    const decision = await h.handler.externalActionDecision(
      new Request("http://session/internal/external-action/decision", {
        method: "POST",
        headers: {
          "X-External-Action-Actor-ID": "user-1",
          "X-Request-ID": "request-1",
        },
        body: JSON.stringify({ actionId: "action-1", decision: "approve" }),
      })
    );
    const read = h.handler.humanExternalActionStatus(
      new Request("http://session/internal/external-action/status?actionId=action-1")
    );

    expect(decision.status).toBe(200);
    expect(read.status).toBe(200);
    expect(h.gateway.approve).toHaveBeenCalledWith("action-1", {
      source: "human",
      actorId: "user-1",
      grantId: null,
      requestId: "request-1",
    });
    expect(h.flushAudit).toHaveBeenCalledOnce();
  });

  it("cancels a prepared effect without needing an approval", async () => {
    const h = externalActionHarness(true);
    const decision = await h.handler.externalActionDecision(
      new Request("http://session/internal/external-action/decision", {
        method: "POST",
        headers: {
          "X-External-Action-Actor-ID": "user-1",
          "X-Request-ID": "request-1",
        },
        body: JSON.stringify({ actionId: "action-1", decision: "cancel", reason: "Superseded" }),
      })
    );

    expect(decision.status).toBe(200);
    expect(h.gateway.cancel).toHaveBeenCalledWith("action-1", "user-1", "Superseded", "request-1");
    expect(h.gateway.approve).not.toHaveBeenCalled();
  });

  it("refuses a new effect while the live deployment mode denies it", async () => {
    const h = externalActionHarness(true, { liveMode: () => "read_only" });
    const response = await h.handler.externalActionPrepare(
      new Request("http://session/internal/pi-external-action/prepare", {
        method: "POST",
        headers: { "X-Pi-Operation-ID": "message-1" },
        body: JSON.stringify(actionRequest),
      })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "external_actions_disabled" });
    expect(h.gateway.prepare).not.toHaveBeenCalled();
  });

  it("refuses an approval while the live deployment mode denies it", async () => {
    const h = externalActionHarness(true, { liveMode: () => "off" });
    const response = await h.handler.externalActionDecision(
      new Request("http://session/internal/external-action/decision", {
        method: "POST",
        headers: {
          "X-External-Action-Actor-ID": "user-1",
          "X-Request-ID": "request-1",
        },
        body: JSON.stringify({ actionId: "action-1", decision: "approve" }),
      })
    );

    expect(response.status).toBe(403);
    expect(h.gateway.approve).not.toHaveBeenCalled();
  });

  it("still lets an approver deny or cancel while the live mode denies new effects", async () => {
    const h = externalActionHarness(true, { liveMode: () => "off" });
    const denied = await h.handler.externalActionDecision(
      new Request("http://session/internal/external-action/decision", {
        method: "POST",
        headers: {
          "X-External-Action-Actor-ID": "user-1",
          "X-Request-ID": "request-1",
        },
        body: JSON.stringify({ actionId: "action-1", decision: "deny" }),
      })
    );

    expect(denied.status).toBe(200);
    expect(h.gateway.deny).toHaveBeenCalled();
    expect(
      h.handler.humanExternalActionStatus(
        new Request("http://session/internal/external-action/status?actionId=action-1")
      ).status
    ).toBe(200);
  });

  it("never returns an internal failure reason to the approver", async () => {
    const h = externalActionHarness(true);
    h.gateway.approve.mockImplementationOnce(() => {
      throw new Error("provider rejected POST https://api.github.com/repos/acme/private/secret");
    });
    const response = await h.handler.externalActionDecision(
      new Request("http://session/internal/external-action/decision", {
        method: "POST",
        headers: {
          "X-External-Action-Actor-ID": "user-1",
          "X-Request-ID": "request-1",
        },
        body: JSON.stringify({ actionId: "action-1", decision: "approve" }),
      })
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toMatchObject({ code: "external_action_failed" });
    expect(JSON.stringify(body)).not.toContain("acme");
    expect(JSON.stringify(body)).not.toContain("api.github.com");
  });
});

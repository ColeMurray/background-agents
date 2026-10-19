import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { PiBridgeHandler } from "./pi-bridge.handler";
import { ExternalActionDefinitionRegistry } from "../../external-action-definitions";
import { SourceControlProviderError } from "../../../source-control";
import type { PiPinnedRepository } from "../../../pi/repository-tools";

function harness(options: { claimedBaseline?: boolean } = {}) {
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
  const handler = new PiBridgeHandler({
    sessions: {
      getSession: () =>
        ({ harness: "pi", base_sha: options.claimedBaseline ? fullSha : null }) as never,
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
    messages: { getProcessingMessage: () => null },
    credentials: { getOpenAIAccess: vi.fn() },
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
  };
}

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
    resolveAutomationApproval?: (
      provider: string,
      action: string
    ) => Promise<{ source: "automation_grant"; actorId: string; grantId: string } | undefined>;
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
      resolveAutomationApproval: options.resolveAutomationApproval,
      flushAudit,
      nextDeadline: () => null,
    },
  });
  return { ...base, handler, gateway, flushAudit };
}

describe("PiBridgeHandler context", () => {
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
    const h = harness();

    const response = await h.handler.context(
      new Request("http://session/internal/pi-context", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "pin" }),
      })
    );

    expect(response.status).toBe(200);
    expect(h.pin).toHaveBeenCalledOnce();
    expect(h.claimBaselines).toHaveBeenCalledWith([]);
  });

  it("restores durable repository pins without resolving branch heads", async () => {
    const h = harness();
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
        headers: { "Content-Type": "application/json" },
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
    const h = harness({ claimedBaseline: true });
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
        headers: { "Content-Type": "application/json" },
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
    const h = harness({ claimedBaseline: true });

    const response = await h.handler.repositoryMaterialization(
      new Request("http://session/internal/pi-repository-materialization", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
    const h = harness({ claimedBaseline: true });
    h.prepareMaterialization.mockRejectedValueOnce(
      new SourceControlProviderError("provider unavailable", "transient", 503)
    );

    const response = await h.handler.repositoryMaterialization(
      new Request("http://session/internal/pi-repository-materialization", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
    expect(h.gateway.prepare).toHaveBeenCalledWith("session-1", "message-1", actionRequest);
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
});

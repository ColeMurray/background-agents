import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  defineExtension,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { externalActionStatusResponseSchema } from "@open-inspect/shared";
import { resolvePiFeatureCapabilities } from "@open-inspect/shared/pi-feature-capabilities";
import { createNodeSqlStorage } from "../node/sqlite-storage";
import { ExternalActionGateway } from "../session/external-action-gateway";
import { PiBridgeHandler } from "../session/http/handlers/pi-bridge.handler";
import { initSchema } from "../session/schema";
import { ExternalActionDefinitionRegistry } from "../session/external-action-definitions";
import { z } from "zod";
import {
  createExternalActionPolicyDelegate,
  createGatewayExternalActionTool,
} from "./external-action-policy-extension";
import { assemblePiExtensions } from "./extension-assembler";
import { createPiToolPolicyExtension } from "./tool-policy-extension";

describe("Pi external action approval integration", () => {
  const databases: DatabaseSync[] = [];
  const harnesses: Harness[] = [];
  afterEach(async () => {
    await Promise.all(harnesses.splice(0).map((harness) => harness.close(BACKGROUND_CONTEXT)));
    databases.splice(0).forEach((database) => database.close());
  });

  it("binds a new real Pi call to approval and executes only through SessionDO", async () => {
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    const storage = createNodeSqlStorage(database);
    initSchema(storage.sql);
    const gateway = new ExternalActionGateway(storage.sql, storage.transactionSync, {
      now: () => 1_000,
      generateId: () => "action-1",
      generateLeaseToken: () => "lease-1",
    });
    const providerExecute = vi.fn(async () => ({
      kind: "succeeded" as const,
      publicResult: { publicationId: "comment-7" },
    }));
    let activeOperationId = "message-1";
    const handler = new PiBridgeHandler({
      sessions: {
        getSession: () => ({ harness: "pi" }) as never,
        getSessionRepositories: () => [],
      },
      messages: { getProcessingMessage: () => ({ id: activeOperationId }) as never },
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
      externalActions: {
        enabled: true,
        gateway,
        definitions: fakeDefinitions({
          execute: providerExecute,
          status: vi.fn(async () => ({ kind: "unknown" as const })),
        }),
      },
      getSessionId: () => "session-1",
    });
    const client = createBindingClient(handler, () => activeOperationId);
    const publication = createGatewayExternalActionTool(
      {
        name: "publish_comment",
        description: "Publish a comment through the authorized gateway.",
        parameters: Type.Object({ body: Type.String() }),
        prepare: (args, toolCallId) => ({
          toolCallId,
          idempotencyKey: `pi:${toolCallId}`,
          provider: "fake",
          action: "publish_comment",
          summary: "Publish review comment",
          target: { repository: "acme/widgets", issue: 42 },
          arguments: { body: args.body },
        }),
      },
      client
    );
    const registry = createRegistry();
    const delegate = createExternalActionPolicyDelegate({
      client,
      externalActions: { publish_comment: publication.describe },
    });
    const assembly = assemblePiExtensions(
      [
        {
          slot: "policy",
          effects: [],
          createExtension: (effects) => createPiToolPolicyExtension(effects, [delegate]),
        },
        {
          slot: "external_actions",
          feature: "externalActions",
          minimumCapability: "enabled",
          extension: defineExtension({ name: "fake.publication", tools: [publication.tool] }),
          effects: [publication.registration],
        },
      ],
      resolvePiFeatureCapabilities({ externalActions: "enabled" })
    );
    for (const extension of assembly.extensions) registry.install(extension);
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("publish_comment", { body: "Looks good" }, { id: "call-1" }),
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage("Approval is required."),
      fauxAssistantMessage(
        fauxToolCall("publish_comment", { body: "Looks good" }, { id: "call-2" }),
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage("Publication confirmed."),
    ]);
    const harness = await Harness.open(
      new MemoryStorage(),
      { models, registry },
      BACKGROUND_CONTEXT
    );
    harnesses.push(harness);
    const model = faux.getModel();
    const conversation = await harness.root(BACKGROUND_CONTEXT, {
      agent: { model: { provider: model.provider, modelId: model.id } },
    });

    const first = await conversation.submit(
      { type: "input", content: "Publish the review." },
      BACKGROUND_CONTEXT
    );
    expect((await first.wait(BACKGROUND_CONTEXT)).status).toBe("done");
    expect(providerExecute).not.toHaveBeenCalled();
    expect(gateway.status("action-1").action.state).toBe("awaiting_approval");

    await handler.externalActionDecision(
      new Request("http://session/internal/external-action/decision", {
        method: "POST",
        headers: { "X-External-Action-Actor-ID": "user-1" },
        body: JSON.stringify({ actionId: "action-1", decision: "approve" }),
      })
    );
    activeOperationId = "message-2";
    const continuation = await conversation.submit(
      { type: "input", content: "Continue the exact approved publication." },
      BACKGROUND_CONTEXT
    );
    expect((await continuation.wait(BACKGROUND_CONTEXT)).status).toBe("done");

    expect(providerExecute).toHaveBeenCalledOnce();
    expect(gateway.isBoundToOperation("action-1", "message-2")).toBe(true);
    expect(gateway.status("action-1").action).toMatchObject({
      state: "succeeded",
      publicResult: { publicationId: "comment-7" },
    });
  });
});

function createBindingClient(handler: PiBridgeHandler, operationId: () => string) {
  const headers = () => ({
    "Content-Type": "application/json",
    "X-Pi-Operation-ID": operationId(),
  });
  return {
    prepare: async (request: unknown) =>
      parseResponse(
        await handler.externalActionPrepare(
          new Request("http://session/internal/pi-external-action/prepare", {
            method: "POST",
            headers: headers(),
            body: JSON.stringify(request),
          })
        )
      ),
    status: async (actionId: string) =>
      parseResponse(
        handler.externalActionStatus(
          new Request(`http://session/internal/pi-external-action/status?actionId=${actionId}`, {
            headers: headers(),
          })
        )
      ),
    execute: async (actionId: string) =>
      parseResponse(
        await handler.externalActionExecute(
          new Request("http://session/internal/pi-external-action/execute", {
            method: "POST",
            headers: headers(),
            body: JSON.stringify({ actionId }),
          })
        )
      ),
  };
}

async function parseResponse(response: Response) {
  expect(response.status).toBe(200);
  return externalActionStatusResponseSchema.parse(await response.json());
}

function fakeDefinitions(executor: {
  execute: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
}) {
  const definitions = new ExternalActionDefinitionRegistry();
  definitions.register({
    provider: "fake",
    action: "publish_comment",
    requestSchema: z.object({
      target: z.object({ repository: z.string(), issue: z.number() }),
      arguments: z.object({ body: z.string() }),
    }),
    publicResultSchema: z.object({ publicationId: z.string() }) as never,
    executor: executor as never,
  });
  return definitions;
}

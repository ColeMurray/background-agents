import type { JsonValue } from "@earendil-works/chord";
import { Type, type ToolCall } from "@earendil-works/pi-ai";
import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import {
  CROSS_SESSION_TOOL_EFFECT_REGISTRATIONS,
  PI_MCP_TOOL_EFFECT_REGISTRATIONS,
  crossSessionDeliveryResultSchema,
  externalActionStatusResponseSchema,
  mcpReadResultSchema,
  mcpSessionPinListSchema,
  type CrossSessionDeliveryResult,
  type ExternalActionPrepareRequest,
  type FeatureCapabilityMode,
  type McpReadResult,
  type PiFeatureCapabilityMatrix,
} from "@open-inspect/shared";
import { SessionInternalPaths } from "../session/contracts";
import type { ExtensionContribution } from "../harness/extension-assembler";
import type { PiToolPolicyDelegate } from "../pi/tool-policy-types";
import type { PiSessionContext } from "../pi/session-context-contract";
import { piTraceHeader } from "../pi/pi-trace";
import {
  createExternalActionPolicyDelegate,
  createGatewayExternalActionTool,
} from "../pi/external-action-policy-extension";
import {
  createCrossSessionExtension,
  createCrossSessionPolicyDelegate,
} from "../pi/cross-session-extension";
import { createMcpExtension } from "../pi/personal-mcp-extension";
import type { ToolEffectRegistration } from "@open-inspect/shared/tool-effects";
import { registerPiRuntimeExtensionFactory } from "../pi/runtime-extension-registry";

export interface PiOverlayRuntimeHost {
  getSessionId(): Promise<string | undefined>;
  attributedOperationId(): Promise<string | null>;
  currentOperationId(): Promise<string | null>;
  fetchSession(sessionId: string, request: Request): Promise<Response>;
}

export class PiOverlayRuntime {
  constructor(private readonly options: PiOverlayRuntimeHost) {}

  contributions(
    sessionContext: PiSessionContext,
    capabilities: PiFeatureCapabilityMatrix,
    currentCapabilities: (
      signal?: AbortSignal
    ) => Promise<Readonly<Record<string, FeatureCapabilityMode>>>
  ): {
    delegates: PiToolPolicyDelegate[];
    extensions: ExtensionContribution<Extension>[];
    ownsMcp: boolean;
  } {
    const externalActions = this.externalActionContributions(sessionContext.externalActions);
    const crossSessionDelegate = createCrossSessionPolicyDelegate({
      client: { authorize: (signal) => this.authorizeCrossSession(signal) },
    });
    const externalActionDelegate = createExternalActionPolicyDelegate({
      client: {
        prepare: (request, signal) => this.prepareExternalAction(request, signal),
        status: (actionId, signal) => this.externalActionStatus(actionId, signal),
        execute: (actionId, signal) => this.executeExternalAction(actionId, signal),
      },
      externalActions: externalActions.describers,
      authorizeNewEffect: async (signal) => {
        const current = await currentCapabilities(signal);
        return current.externalActions === "enabled"
          ? { allowed: true }
          : {
              allowed: false,
              reason: "External actions are disabled for new effects by deployment policy",
            };
      },
    });
    const extensions: ExtensionContribution<Extension>[] = [externalActions.contribution];
    if (capabilities.crossSessionMessaging === "enabled") {
      extensions.push({
        slot: "cross_session",
        feature: "crossSessionMessaging",
        minimumCapability: "enabled",
        extension: createCrossSessionExtension({
          client: { send: (request, signal) => this.sendCrossSessionMessage(request, signal) },
        }),
        effects: CROSS_SESSION_TOOL_EFFECT_REGISTRATIONS,
        ownedToolNames: CROSS_SESSION_TOOL_EFFECT_REGISTRATIONS.map((effect) => effect.name),
      });
    }
    if (capabilities.mcp !== "off") {
      extensions.push({
        slot: "mcp",
        feature: "mcp",
        minimumCapability: "read_only",
        extension: createMcpExtension({
          client: {
            read: (request, signal) => this.readMcpTool(request, signal),
            list: (signal) => this.listMcpGrants(signal),
          },
        }),
        effects: PI_MCP_TOOL_EFFECT_REGISTRATIONS,
      });
    }
    return { delegates: [externalActionDelegate, crossSessionDelegate], extensions, ownsMcp: true };
  }

  private async authorizeCrossSession(
    signal?: AbortSignal
  ): Promise<{ allowed: boolean; code?: string; reason?: string }> {
    const sessionId = await this.options.getSessionId();
    if (!sessionId) return { allowed: false, reason: "The session is not initialized" };
    const operationId = await this.options.attributedOperationId();
    const response = await this.options.fetchSession(
      sessionId,
      new Request(`http://session${SessionInternalPaths.crossSessionAuthorize}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(operationId ? { "X-Pi-Operation-ID": operationId } : {}),
          ...(operationId ? piTraceHeader(operationId) : {}),
        },
        body: JSON.stringify({}),
        signal,
      })
    );
    const body = (await response.json().catch(() => null)) as {
      allowed?: boolean;
      code?: string;
      reason?: string;
    } | null;
    if (!response.ok || !body?.allowed) {
      return {
        allowed: false,
        ...(body?.code ? { code: body.code } : {}),
        reason: body?.reason ?? "Cross-session messaging is not available for this session",
      };
    }
    return { allowed: true };
  }

  /**
   * Read one reviewed MCP tool through the owning session.
   *
   * The session resolves the grant, the reviewed catalog, and the owner's
   * identity. The agent never holds a credential and never names one.
   */
  private async readMcpTool(
    request: {
      connectionId?: string;
      serverId?: string;
      toolName: string;
      arguments: Record<string, unknown>;
    },
    signal?: AbortSignal
  ): Promise<McpReadResult> {
    const sessionId = await this.options.getSessionId();
    if (!sessionId) throw new Error("Pi Durable session is not initialized");
    const operationId = await this.options.attributedOperationId();
    if (!operationId) throw new Error("Pi Durable has no attributed active operation");
    const response = await this.options.fetchSession(
      sessionId,
      new Request(`http://session${SessionInternalPaths.piMcpRead}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Pi-Operation-ID": operationId,
          ...piTraceHeader(operationId),
        },
        body: JSON.stringify(request),
        signal,
      })
    );
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(
        typeof (body as { error?: unknown } | null)?.error === "string"
          ? (body as { error: string }).error
          : "The MCP read did not complete"
      );
    }
    return mcpReadResultSchema.parse(body);
  }

  /** The session's authorized MCP attachments. */
  private async listMcpGrants(signal?: AbortSignal): Promise<{
    grants: Array<{ connectionId: string; serverName: string; toolNames: string[] }>;
    shared: Array<{ serverId: string; serverName: string; toolNames: string[] }>;
  }> {
    const sessionId = await this.options.getSessionId();
    if (!sessionId) throw new Error("Pi Durable session is not initialized");
    const operationId = await this.options.currentOperationId();
    if (!operationId) throw new Error("Pi Durable has no attributed active operation");
    const response = await this.options.fetchSession(
      sessionId,
      new Request(`http://session${SessionInternalPaths.piMcpList}`, {
        method: "GET",
        headers: { "X-Pi-Operation-ID": operationId },
        ...(signal ? { signal } : {}),
      })
    );
    const body = await response.json().catch(() => null);
    if (!response.ok) return { grants: [], shared: [] };
    const parsed = mcpSessionPinListSchema.safeParse(body);
    return parsed.success
      ? {
          grants: parsed.data.pins.map((pin) => ({
            connectionId: pin.connectionId,
            serverName: pin.serverName,
            toolNames: pin.toolNames,
          })),
          shared: parsed.data.shared.map((server) => ({
            serverId: server.serverId,
            serverName: server.serverName,
            toolNames: server.toolNames,
          })),
        }
      : { grants: [], shared: [] };
  }

  /**
   * Read one fact through the owning session.
   *
   * The session resolves the identity, the partition, and the session
   * principal's current access to it. The agent never holds a credential and
   * never names a scope it was not given.
   */
  /**
   * Ask the owning session to hand one message to another session.
   *
   * The owning session owns the authority. The agent never reaches another
   * session directly, and it never names the user it speaks for.
   */
  private async sendCrossSessionMessage(
    request: {
      targetSessionId: string;
      content: string;
      idempotencyKey: string;
      agentConversationId: string | null;
      sourceTaskId: string | null;
    },
    signal?: AbortSignal
  ): Promise<CrossSessionDeliveryResult> {
    const sessionId = await this.options.getSessionId();
    if (!sessionId) throw new Error("Pi Durable session is not initialized");
    const operationId = await this.options.attributedOperationId();
    if (!operationId) throw new Error("Pi Durable has no attributed active operation");
    const response = await this.options.fetchSession(
      sessionId,
      new Request(`http://session${SessionInternalPaths.crossSessionMessage}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Pi-Operation-ID": operationId,
          ...piTraceHeader(operationId),
        },
        body: JSON.stringify(request),
        signal,
      })
    );
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const reason =
        typeof (body as { error?: unknown } | null)?.error === "string"
          ? (body as { error: string }).error
          : "The cross-session message was refused";
      return { receiptId: "", status: "rejected", messageId: null, reason };
    }
    return crossSessionDeliveryResultSchema.parse(body);
  }
  /**
   * The publication tools this session may call.
   *
   * A tool exists only for a provider the deployment named and holds a
   * credential for, so the model never sees a publication that could not
   * complete. Every tool is owned by the external-action policy delegate,
   * which asks this session to authorize the effect before anything is
   * published.
   */
  private externalActionContributions(
    providers: ReadonlyArray<PiSessionContext["externalActions"][number]>
  ): {
    contribution: ExtensionContribution<Extension>;
    describers: Record<
      string,
      (call: ToolCall) => ExternalActionPrepareRequest | Promise<ExternalActionPrepareRequest>
    >;
  } {
    const describers: Record<
      string,
      (call: ToolCall) => ExternalActionPrepareRequest | Promise<ExternalActionPrepareRequest>
    > = {};
    if (providers.length === 0) {
      return {
        contribution: {
          slot: "external_actions",
          feature: "externalActions",
          minimumCapability: "enabled",
          extension: defineExtension({ name: "open-inspect.external-actions" }),
          effects: [],
          ownedToolNames: [],
        },
        describers,
      };
    }
    const effects: ToolEffectRegistration[] = [];
    const tools = [];
    for (const provider of providers) {
      const toolName = provider.toolName;
      const { tool, describe, registration } = createGatewayExternalActionTool(
        {
          name: toolName,
          description: `Publish a ${provider.action} to ${provider.provider}.`,
          parameters: Type.Object({
            target: Type.Record(Type.String(), Type.Unknown()),
            arguments: Type.Record(Type.String(), Type.Unknown()),
          }),
          prepare: (args, toolCallId) => ({
            toolCallId,
            idempotencyKey: `pi:${toolCallId}`,
            provider: provider.provider,
            action: provider.action,
            summary: `Publish a ${provider.action} to ${provider.provider}`,
            target: args.target as Record<string, JsonValue>,
            arguments: args.arguments as Record<string, JsonValue>,
          }),
        },
        {
          prepare: (request, signal) => this.prepareExternalAction(request, signal),
          status: (actionId, signal) => this.externalActionStatus(actionId, signal),
          execute: (actionId, signal) => this.executeExternalAction(actionId, signal),
        }
      );
      tools.push(tool);
      effects.push(registration);
      describers[toolName] = describe;
    }
    return {
      contribution: {
        slot: "external_actions",
        feature: "externalActions",
        minimumCapability: "enabled",
        extension: defineExtension({ name: "open-inspect.external-actions", tools }),
        effects,
        ownedToolNames: effects.map((effect) => effect.name),
      },
      describers,
    };
  }

  private async prepareExternalAction(request: ExternalActionPrepareRequest, signal?: AbortSignal) {
    return this.externalActionRequest(
      SessionInternalPaths.piExternalActionPrepare,
      { method: "POST", body: JSON.stringify(request) },
      signal
    );
  }

  private async externalActionStatus(actionId: string, signal?: AbortSignal) {
    return this.externalActionRequest(
      SessionInternalPaths.piExternalActionStatus,
      { method: "GET" },
      signal,
      `?actionId=${encodeURIComponent(actionId)}`
    );
  }

  private async executeExternalAction(actionId: string, signal?: AbortSignal) {
    return this.externalActionRequest(
      SessionInternalPaths.piExternalActionExecute,
      { method: "POST", body: JSON.stringify({ actionId }) },
      signal
    );
  }

  private async externalActionRequest(
    path:
      | typeof SessionInternalPaths.piExternalActionPrepare
      | typeof SessionInternalPaths.piExternalActionStatus
      | typeof SessionInternalPaths.piExternalActionExecute,
    init: RequestInit,
    signal?: AbortSignal,
    search = ""
  ) {
    const sessionId = await this.options.getSessionId();
    if (!sessionId) throw new Error("Pi Durable session is not initialized");
    const operationId = await this.options.attributedOperationId();
    if (!operationId) throw new Error("Pi Durable has no attributed active operation");
    const response = await this.options.fetchSession(
      sessionId,
      new Request(`http://session${path}${search}`, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          "X-Pi-Operation-ID": operationId,
          ...piTraceHeader(operationId),
        },
        signal,
      })
    );
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      const message =
        typeof body === "object" &&
        body !== null &&
        "error" in body &&
        typeof body.error === "string"
          ? body.error
          : `External action policy failed (${response.status})`;
      throw new Error(message);
    }
    return externalActionStatusResponseSchema.parse(await response.json());
  }
}

registerPiRuntimeExtensionFactory((host, context, capabilities, currentCapabilities) =>
  new PiOverlayRuntime(host).contributions(context, capabilities, currentCapabilities)
);

import { SessionInternalPaths } from "./contracts";
import {
  registerSessionExtensionServicesFactory,
  type SessionExtensionServicesContext,
} from "./extension-services";
import { createOverlaySessionInternalRoutes } from "./http/overlay-routes";
import { createPiDeploymentCapabilitySnapshot } from "../pi/deployment-capabilities";
import { McpServerReviewStore } from "../db/mcp-server-reviews";
import { McpServerStore } from "../db/mcp-servers";
import { callSharedMcpTool } from "./mcp-shared-client";
import { McpConnectionStore } from "../db/mcp-connections";
import { McpReadAuditStore } from "../db/mcp-read-audit";
import {
  McpSessionPinConflictError,
  McpSessionPinStore,
  McpSessionPinValidationError,
} from "../db/mcp-session-pins";
import {
  evaluateMcpGrantScope,
  evaluateMcpGrantTool,
  reviewedReadOnlyToolNames,
} from "./mcp-grant-scope";
import { McpSessionHandler } from "./http/handlers/personal-mcp-session.handler";
import { CrossSessionHandler } from "./http/handlers/cross-session.handler";
import { CrossSessionReceiptStore } from "../db/cross-session-receipts";
import { evaluateCrossSessionSource, evaluateCrossSessionTarget } from "./cross-session-authority";
import { parseTeamsEnforcementMode } from "../authorization/teams-enforcement";
import { createSessionRuntimeClientForTrace } from "./runtime-client";
import { ExternalActionGateway } from "./external-action-gateway";
import { ExternalActionAuditOutbox } from "./external-action-audit-outbox";
import { getGitHubAppConfig } from "../auth/github-app";
import { buildExternalActionProviderRegistry } from "./external-action-providers/registry";
import {
  EXTERNAL_ACTION_REQUEST_TIMEOUT_MS,
  parseExternalActionProviders,
  providerAuthorizationHeader,
  providerFetch,
} from "./external-action-credentials";
import {
  ExternalActionAuditStore,
  type ExternalActionAuditInput,
} from "../db/external-action-audit";
import { AutomationExternalActionGrantStore } from "../db/automation-external-action-grants";
import { ExternalActionBridgeHandler } from "./http/handlers/external-action-bridge.handler";

export function createOverlaySessionServices(context: SessionExtensionServicesContext) {
  const {
    env,
    db,
    sql,
    transaction,
    durableObjectId,
    repoSecretsEncryptionKey,
    getPublicSessionId,
    resolveCredentialScope,
    sourceControlProvider,
    sessionIndexStore,
    sessionCoreRepository,
    messageRepository,
    eventRepository,
    messageService,
    alarmScheduler,
    activeOperation,
    turnAuthorMayAct,
  } = context;
  const externalActionGateway = new ExternalActionGateway(sql, transaction);
  const externalActionAuditOutbox = new ExternalActionAuditOutbox(sql, transaction);
  // A provider is registered only when the deployment named it. Every
  // definition in the registry has passed the generic fault-injection
  // conformance suite, and the credential is resolved per call.
  const externalActionCredentialResolver = {
    available: async (provider: string) => {
      // A cheap check. It never mints a token and never reaches a provider.
      if (provider === "github") return getGitHubAppConfig(env) !== null;
      if (provider === "gitlab") return Boolean(env.GITLAB_ACCESS_TOKEN?.trim());
      if (provider === "slack") return Boolean(env.SLACK_BOT_TOKEN?.trim());
      if (provider === "linear") return Boolean(env.LINEAR_API_KEY?.trim());
      return false;
    },
    resolve: async (provider: string) => {
      if (provider === "github" || provider === "gitlab") {
        const scoped = await resolveCredentialScope(getPublicSessionId());
        const auth = await sourceControlProvider().generateCredentialHelperAuth(scoped);
        return {
          headers: {
            ...providerAuthorizationHeader(provider as "github" | "gitlab", auth.password),
            "user-agent": "open-inspect",
          },
        };
      }
      if (provider === "slack") {
        const token = env.SLACK_BOT_TOKEN?.trim();
        if (!token) return null;
        return { headers: providerAuthorizationHeader("slack", token) };
      }
      if (provider === "linear") {
        const token = env.LINEAR_API_KEY?.trim();
        if (!token) return null;
        return { headers: providerAuthorizationHeader("linear", token) };
      }
      return null;
    },
  };
  const externalActionDefinitions = buildExternalActionProviderRegistry({
    credentials: externalActionCredentialResolver,
    fetch: providerFetch,
    timeoutMs: EXTERNAL_ACTION_REQUEST_TIMEOUT_MS,
    userAgent: "open-inspect",
    enabledProviders: parseExternalActionProviders(env.PI_EXTERNAL_ACTION_PROVIDERS),
  });
  const projectExternalActionAudit = async (input: Omit<ExternalActionAuditInput, "teamId">) => {
    const session = await sessionIndexStore.get(getPublicSessionId());
    await new ExternalActionAuditStore(db).write({
      ...input,
      teamId: session?.ownerTeamId ?? null,
    });
  };
  const nextExternalActionDeadline = () => {
    const deadlines = [
      externalActionGateway.nextReconciliationAt(),
      externalActionGateway.nextExpiryAt(),
      externalActionAuditOutbox.nextDeadline(),
    ].filter((deadline): deadline is number => deadline !== null);
    return deadlines.length > 0 ? Math.min(...deadlines) : null;
  };
  const mcpReviewStore = new McpServerReviewStore(db);
  const mcpStore = new McpServerStore(db, repoSecretsEncryptionKey);
  const mcpGrantScope = {
    db,
    servers: new McpServerStore(db, repoSecretsEncryptionKey),
    connections: new McpConnectionStore(db),
    reviewedToolNames: (serverId: string, serverRevision: number) =>
      reviewedReadOnlyToolNames(db, serverId, serverRevision),
  };
  const mcpSessionHandler = new McpSessionHandler({
    mcp: {
      liveMode: () => createPiDeploymentCapabilitySnapshot(env).capabilities.mcp,
      sessionCapability: () =>
        sessionCoreRepository.getPiFeatureCapabilitySnapshot()?.capabilities.mcp ?? "off",
      grantPin: async (input) => {
        // The connection is the caller's own, and it must name a server this
        // session may use: the same repository scope the shared MCP servers
        // obey, resolved from the session's own repositories. The call path
        // asks the same question, so both answers come from one function.
        const scope = await evaluateMcpGrantScope(mcpGrantScope, {
          connectionId: input.connectionId,
          ownerUserId: input.ownerUserId,
          repositories: sessionCoreRepository.getSessionRepositories(),
        });
        if (scope.kind === "denied") return { error: scope.reason };
        try {
          const pin = await new McpSessionPinStore(db).grant({
            ownerUserId: input.ownerUserId,
            connectionId: input.connectionId,
            sessionId: getPublicSessionId(),
            catalogSnapshotSha256: input.catalogSnapshotSha256,
            toolNames: input.toolNames,
          });
          return {
            id: pin.id,
            sessionId: pin.sessionId,
            connectionId: pin.connectionId,
            toolNames: pin.toolNames,
            createdAt: pin.createdAt,
          };
        } catch (error) {
          if (
            error instanceof McpSessionPinConflictError ||
            error instanceof McpSessionPinValidationError
          ) {
            return { error: error.message };
          }
          throw error;
        }
      },
      grants: async () => {
        const pins = await new McpSessionPinStore(db).listForSession(getPublicSessionId());
        const connections = new McpConnectionStore(db);
        const grants = [];
        for (const pin of pins) {
          // A grant whose server was disabled, or whose repository scope was
          // narrowed, is no longer usable. It is not listed, so it is not
          // offered as a capability it does not have.
          const scope = await evaluateMcpGrantScope(mcpGrantScope, {
            connectionId: pin.connectionId,
            ownerUserId: pin.ownerUserId,
            repositories: sessionCoreRepository.getSessionRepositories(),
          });
          if (scope.kind === "denied") continue;
          const connection = await connections.getOwned(pin.connectionId, pin.ownerUserId);
          if (!connection) continue;
          grants.push({
            id: pin.id,
            connectionId: pin.connectionId,
            serverName: connection.serverName,
            endpointHost: new URL(connection.endpointUrl).host,
            toolNames: pin.toolNames,
            sessionId: pin.sessionId,
            createdAt: pin.createdAt,
            ownerUserId: pin.ownerUserId,
          });
        }
        return grants;
      },
      sharedServers: async () => {
        const repositories = sessionCoreRepository.getSessionRepositories();
        const servers = await mcpStore.getDecryptedForSession(
          repositories.map(({ repoOwner, repoName }) => ({ repoOwner, repoName }))
        );
        const views = [];
        for (const server of servers) {
          const metadata = await mcpStore.get(server.id);
          if (!metadata) continue;
          const toolNames = await mcpReviewStore.reviewedReadOnlyToolNames(
            server.id,
            metadata.revision
          );
          if (toolNames.length === 0) continue;
          views.push({
            serverId: server.id,
            serverName: server.name,
            endpointHost: new URL(server.url ?? "https://mcp.invalid").host,
            toolNames,
          });
        }
        return views;
      },
      callSharedTool: async (request) => {
        // The session's own repositories decide which servers exist here, so
        // the shared lane is scoped exactly like the sandbox's.
        const repositories = sessionCoreRepository.getSessionRepositories();
        const servers = await mcpStore.getDecryptedForSession(
          repositories.map(({ repoOwner, repoName }) => ({ repoOwner, repoName }))
        );
        const server = servers.find((entry) => entry.id === request.serverId);
        if (!server) {
          throw new Error("This MCP server is not available to this session");
        }
        const metadata = await mcpStore.get(server.id);
        if (!metadata) {
          throw new Error("This MCP server is not available to this session");
        }
        const toolNames = await mcpReviewStore.reviewedReadOnlyToolNames(
          server.id,
          metadata.revision
        );
        if (!toolNames.includes(request.toolName)) {
          throw new Error("This MCP tool is not part of the reviewed catalog");
        }
        return callSharedMcpTool(
          {
            id: server.id,
            name: server.name,
            type: server.type,
            url: server.url,
            headers: server.headers,
            env: server.env,
          },
          request.toolName,
          request.arguments
        );
      },
      callTool: async (request) => {
        const broker = env.MCP_CONNECTION;
        if (!broker) throw new Error("MCP connections are not enabled for this deployment");
        const pins = await new McpSessionPinStore(db).listForSession(getPublicSessionId());
        const pin = pins.find((entry) => entry.connectionId === request.connectionId);
        if (!pin) throw new Error("This MCP connection is not granted to the session");
        // The pin is an input to this decision, not the decision. The server's
        // scope, its enabled flag and its current reviewed catalogue are read
        // again here, so a server that was disabled, narrowed or re-reviewed
        // stops being callable through a grant taken earlier.
        const scope = await evaluateMcpGrantTool(mcpGrantScope, {
          connectionId: request.connectionId,
          ownerUserId: pin.ownerUserId,
          repositories: sessionCoreRepository.getSessionRepositories(),
          toolName: request.toolName,
          pinnedToolNames: pin.toolNames,
        });
        if (scope.kind === "denied") throw new Error(scope.reason);
        const result = await broker.callTool({
          connectionId: request.connectionId,
          // The provider sees the connection owner's identity, never the
          // actor's and never a credential.
          ownerUserId: pin.ownerUserId,
          toolName: request.toolName,
          arguments: request.arguments as Record<string, never>,
        });
        return result.content;
      },
      audit: async (input) => {
        await new McpReadAuditStore(db).write({ ...input, sessionId: getPublicSessionId() });
      },
      operationActor: (operationId) => messageRepository.getMessageCanonicalActor(operationId),
      authorMayAct: turnAuthorMayAct,
    },
    getSessionId: getPublicSessionId,
  });
  const crossSessionHandler = new CrossSessionHandler({
    crossSession: {
      liveMode: () => createPiDeploymentCapabilitySnapshot(env).capabilities.crossSessionMessaging,
      sessionCapability: () =>
        sessionCoreRepository.getPiFeatureCapabilitySnapshot()?.capabilities
          .crossSessionMessaging ?? "off",
      receipts: new CrossSessionReceiptStore(db),
      authorizeTarget: (request) =>
        evaluateCrossSessionTarget(db, parseTeamsEnforcementMode(env.TEAMS_ENFORCEMENT), request),
      authorizeSource: (request) =>
        evaluateCrossSessionSource(db, parseTeamsEnforcementMode(env.TEAMS_ENFORCEMENT), request),
      deliver: (targetSessionId, delivery) =>
        createSessionRuntimeClientForTrace(env, durableObjectId).fetch(
          targetSessionId,
          SessionInternalPaths.crossSessionInbound,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(delivery),
          }
        ),
      operationActor: (operationId) => messageRepository.getMessageHumanActor(operationId),
      operationBelongsToSession: (operationId) =>
        messageRepository.getMessageById(operationId) !== null,
      recordSend: (input) => {
        eventRepository.createEvent({
          id: `cross-session:${input.receiptId}`,
          type: "cross_session_message",
          data: JSON.stringify({
            targetSessionId: input.targetSessionId,
            receiptId: input.receiptId,
            status: input.status,
            reason: input.reason,
            actorId: input.actorId,
          }),
          messageId: input.operationId,
          createdAt: Date.now(),
        });
      },
    },
    messages: messageService,
    getSessionId: getPublicSessionId,
  });
  const externalActionBridgeHandler = new ExternalActionBridgeHandler(
    {
      enabled: true,
      gateway: externalActionGateway,
      liveMode: () => createPiDeploymentCapabilitySnapshot(env).capabilities.externalActions,
      definitions: externalActionDefinitions,
      credentialAvailable: async (provider) => externalActionCredentialResolver.available(provider),
      scheduleReconciliation: (deadline) => alarmScheduler.schedule(deadline),
      flushAudit: () => externalActionAuditOutbox.flush(projectExternalActionAudit),
      nextDeadline: nextExternalActionDeadline,
      operationIsUnattended: (operationId) =>
        messageRepository.getMessageActor(operationId)?.kind !== "user",
      resolveAutomationApproval: async (provider, action) => {
        const session = await sessionIndexStore.get(getPublicSessionId());
        if (!session?.automationId || !session.userId) return undefined;
        const grant = await new AutomationExternalActionGrantStore(db).findActive(
          session.automationId,
          session.userId,
          provider,
          action
        );
        return grant
          ? {
              source: "automation_grant" as const,
              actorId: grant.executorUserId,
              grantId: grant.id,
            }
          : undefined;
      },
    },
    getPublicSessionId,
    activeOperation
  );
  const alarm = {
    recoverDue: () =>
      Promise.resolve()
        .then(() => externalActionGateway.expireDue(getPublicSessionId()))
        .then(() =>
          externalActionGateway.reconcileDue((action) =>
            externalActionDefinitions.executorFor(action.provider, action.action)
          )
        )
        .then(() => externalActionAuditOutbox.flush(projectExternalActionAudit)),
    nextDeadline: nextExternalActionDeadline,
  };

  const routeHandlers = {
    piExternalActionPrepare: (request: Request) =>
      externalActionBridgeHandler.externalActionPrepare(request),
    piExternalActionStatus: (request: Request) =>
      externalActionBridgeHandler.externalActionStatus(request),
    piExternalActionExecute: (request: Request) =>
      externalActionBridgeHandler.externalActionExecute(request),
    crossSessionMessage: (request: Request) => crossSessionHandler.outbound(request),
    crossSessionAuthorize: (request: Request) => crossSessionHandler.authorize(request),
    mcpPinGrant: (request: Request) => mcpSessionHandler.grantPin(request),
    piMcpList: (request: Request) => mcpSessionHandler.list(request),
    piMcpRead: (request: Request) => mcpSessionHandler.read(request),
    crossSessionInbound: (request: Request) => crossSessionHandler.inbound(request),
    externalActionStatus: (request: Request) =>
      externalActionBridgeHandler.humanExternalActionStatus(request),
    externalActionPending: (request: Request) =>
      externalActionBridgeHandler.externalActionPending(request),
    externalActionDecision: (request: Request) =>
      externalActionBridgeHandler.externalActionDecision(request),
  };
  return {
    createRoutes: (handlers: Parameters<typeof createOverlaySessionInternalRoutes>[0]) =>
      createOverlaySessionInternalRoutes(handlers, routeHandlers),
    alarm,
    contextContributions: () => externalActionBridgeHandler.contextContributions(),
    components: { externalActionGateway, externalActionDefinitions },
    async rehydrate(): Promise<void> {
      const deadline = nextExternalActionDeadline();
      if (deadline !== null) await alarmScheduler.schedule(Math.max(deadline, Date.now() + 1_000));
    },
  };
}

registerSessionExtensionServicesFactory(createOverlaySessionServices);

import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Workspace, type DurableObjectStorageLike } from "@cloudflare/computer";
import {
  PI_CODEMODE_TOOL_EFFECT_REGISTRATIONS,
  PI_TOOL_EFFECT_REGISTRY,
  normalizeTokenUsage,
  piFeatureCapabilitySnapshotSchema,
  type PiFeatureCapabilitySnapshot,
  type ToolEffectRegistration,
} from "@open-inspect/shared";
import { RemoteCodemodeSandbox } from "@earendil-works/pi-codemode/portable";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import {
  createRegistry,
  defineExtension,
  Harness,
  type AgentEvent,
  type AgentEventStream,
  type EntryRecord,
  type ConversationId,
  type EntryId,
  type TaskId,
  type SubmissionId,
  type UsageState,
} from "@earendil-works/pi-durable";
import { DurableObject } from "cloudflare:workers";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { SessionInternalPaths } from "../session/contracts";
import { CodexBrokerCredentialStore } from "../pi/codex-credential-store";
import { PiProjectionCapability } from "../pi/projection-capability";
import {
  PermanentPiResultDeliveryError,
  RetryablePiProjectionError,
} from "../pi/projection-retry-policy";
import { translatePiEvents, type PiEventTranslationState } from "../pi/event-translator";
import {
  toPiModel,
  toPiThinkingLevel,
  type PiRuntimePrompt,
  type PiRuntimeOperationStatus,
  type PiRuntimeReceipt,
  type PiRuntimeResult,
  type PiRuntimeUsage,
  type PiRuntimeControl,
  type PiRuntimeControlResult,
} from "../pi/runtime-contract";
import type { WorkerBindings } from "./platform";
import {
  piRepositoryPinsSchema,
  piSessionContextSchema,
  type PiSessionContext,
} from "../pi/session-context-contract";
import {
  piRepositoryMaterializationBatchSchema,
  piRepositoryMaterializationManifestSchema,
  piRepositoryMaterializationSchema,
  PI_REPOSITORY_MAX_BYTES,
  type PiRepositoryMaterialization,
  type PiRepositoryMaterializationManifest,
} from "../pi/repository-materialization-contract";
import {
  createAgentMessagingExtension,
  createOpenInspectExtension,
  createSubagentExtension,
  AGENT_MESSAGING_EXTENSION_NAME,
  SUBAGENT_EXTENSION_NAME,
  type PiAgentControlRequest,
} from "../pi/open-inspect-extension";
import { skillSourceFromInstallation } from "../pi/skill-source";
import { createManagedSkillsExtension } from "../pi/managed-skills-extension";
import { createComputerWorkspaceCapability } from "../pi/computer-workspace-extension";
import {
  COMPUTER_SCRATCH_ROOT,
  WorkspaceMutationFifo,
  createQuotaWorkspace,
  createLazyWorkspaceToolFacade,
  createWorkspaceToolFacade,
  ensureRealWorkspaceDirectory,
  type WorkspaceToolFacade,
} from "../pi/computer-workspace-quota";
import { createRepositoryEditingWorkspaceCapability } from "../pi/repository-editing-capability";
import { assemblePiExtensions, type PiExtensionContribution } from "../pi/extension-assembler";
import {
  createPiToolPolicyExtension,
  type PiToolPolicyDelegate,
} from "../pi/tool-policy-extension";
import {
  PI_FEATURE_CAPABILITY_SNAPSHOT_KEY,
  PI_LEGACY_FEATURE_CAPABILITY_SNAPSHOT,
  readPiFeatureCapabilitySnapshot,
} from "../pi/capability-snapshot";
import { PiRepositoryWorkspace } from "../pi/repository-workspace";
import { z } from "zod";
import {
  externalActionStatusResponseSchema,
  crossSessionDeliveryResultSchema,
  mcpReadResultSchema,
  mcpSessionPinListSchema,
  type McpReadResult,
  type CrossSessionDeliveryResult,
  type ExternalActionPrepareRequest,
} from "@open-inspect/shared";
import { createExternalActionPolicyDelegate } from "../pi/external-action-policy-extension";
import { createBrowserPolicyDelegate } from "../pi/browser-policy-extension";
import {
  createSandboxExecutionExtension,
  createSandboxExecutionPolicyDelegate,
  type SandboxExecutionToolRequest,
  type SandboxExecutionToolResponse,
} from "../pi/sandbox-execution-extension";
import {
  createCrossSessionExtension,
  CROSS_SESSION_TOOL_EFFECT_REGISTRATIONS,
} from "../pi/cross-session-extension";
import { createMcpExtension } from "../pi/mcp-extension";
import {
  PI_MCP_TOOL_EFFECT_REGISTRATIONS,
  PI_SANDBOX_EXECUTION_TOOL_EFFECT_REGISTRATIONS,
} from "@open-inspect/shared";
import {
  PiCodeModeExecutionCoordinator,
  createOpenInspectCodemodeExtension,
  createPiCodeModePolicyDelegate,
  createPiCodeModePolicyState,
  createDurableCodeModeParentRegistry,
} from "../pi/codemode-extension";
import {
  SESSION_DIFF_MAX_ERROR_LENGTH,
  type SessionDiffUpload,
} from "@open-inspect/shared/types/session-diffs";
import type { SandboxIngressEvent } from "@open-inspect/shared/types/sandbox-events";
import { createPiDeploymentEmergencyPolicy } from "../pi/deployment-emergency-policy";
import { fetchPiCapabilityAuthority } from "../pi/capability-authority-client";
import { PermanentPiProjectionError, PiProjectionOutbox } from "../pi/projection-outbox";
import { piAgentEventIdentity, piProjectionIdentity } from "../pi/projection-identity";
import { calculatePiUsageCost, hasTrustedPiPricing } from "../pi/pricing";
import {
  operationAccountingDelta,
  summarizePiUsage,
  type PiAccountingSnapshot,
} from "../pi/accounting";
import {
  PermanentRepositoryDiffPublicationError,
  RepositoryDiffOutbox,
  type RepositoryDiffPublicationOutcome,
} from "../pi/repository-diff-outbox";
import { RepositoryDiffPublicationCapability } from "../pi/repository-diff-publication";
import { OpenInspectPiTelemetryContext } from "../pi/pi-telemetry";
import { PiHarnessWakeController } from "../pi/pi-harness-wake";
import { piTraceHeader, piTraceId } from "../pi/pi-trace";
import { createLogger } from "../logger";

type PiWorkerBindings = Pick<WorkerBindings, "SESSION" | "CODEMODE_SANDBOX">;

const SESSION_ID_KEY = "open-inspect:session-id";
const DELETION_STATE_KEY = "open-inspect:deletion-state";
const REPOSITORY_PINS_KEY = "open-inspect:repository-pins";
const ROOT_SESSION = "1";
const sandboxExecutionToolResponseSchema = z
  .object({
    command: z
      .object({
        id: z.string(),
        state: z.string(),
        outputTruncated: z.boolean(),
        exitCode: z.number().nullable(),
        signal: z.string().nullable(),
        error: z.string().nullable(),
      })
      .optional(),
    chunks: z
      .array(
        z.object({
          sequence: z.number().int(),
          stream: z.enum(["stdout", "stderr"]),
          data: z.string(),
        })
      )
      .optional(),
    nextSequence: z.number().int().nullable().optional(),
  })
  .passthrough();
const OPERATION_METADATA_PREFIX = "open-inspect:operation:";
const CONTROL_COMPLETION_PREFIX = "open-inspect:control-completion:";
const CONTROL_SUBMISSION_REQUEST_PREFIX = "open-inspect-control:";
const MAX_OPERATION_METADATA_TOMBSTONES = 128;
const DIFF_FAILURE_REPORT_TIMEOUT_MS = 5_000;
const MAX_PENDING_AGENT_MESSAGES = 16;

interface PiOperationMetadata {
  readonly model: string;
  readonly baseline: PiAccountingSnapshot;
  readonly projectedCostUsd: number;
  readonly settledAt?: number;
}
interface NativeControlCompletion {
  readonly sessionId: string;
  readonly requestId: string;
  readonly baseline: PiAccountingSnapshot;
  readonly suppressCost: boolean;
  readonly target:
    | { readonly kind: "submission"; readonly id: number }
    | { readonly kind: "task"; readonly id: number };
}
/** OpenCode-free, sandbox-free Pi runtime for one Open-Inspect session. */
export class PiSessionDO extends DurableObject<PiWorkerBindings> {
  private readonly log = createLogger("pi-session-do", {
    harness: "pi",
    execution_backend: "durable_object",
  });
  private readonly telemetry = new OpenInspectPiTelemetryContext({ logger: this.log });
  private wakeController: PiHarnessWakeController | undefined;
  private readonly credentials = new CodexBrokerCredentialStore((version, signal) =>
    this.fetchCodexCredential(version, signal)
  );
  private readonly models = createModels({ credentials: this.credentials });
  private readonly registry = createRegistry();
  private workspace: WorkspaceToolFacade | undefined;
  private codemodeSandbox: RemoteCodemodeSandbox | undefined;
  private codeModeCoordinator: PiCodeModeExecutionCoordinator | undefined;
  private rawWorkspace: Workspace | undefined;
  private repositoryWorkspace: PiRepositoryWorkspace | undefined;
  private repositoryWorkspaceInitialization: Promise<PiRepositoryWorkspace> | undefined;
  private repositoryWorkspaceInitializer:
    ((signal?: AbortSignal) => Promise<PiRepositoryWorkspace>) | undefined;
  private readonly repositoryWorkspaceAbort = new AbortController();
  private harnessOpened = false;
  private eventStream: AgentEventStream | undefined;
  private eventStreamOpening: Promise<AgentEventStream> | undefined;
  private readonly projectedOperations = new Set<string>();
  private readonly translationStateByOperation = new Map<string, PiEventTranslationState>();
  private eventRouterWork: Promise<void> = Promise.resolve();
  private readonly eventRelayWork = new Map<string, Promise<void>>();
  private readonly firstModelRequestObserved = new Set<string>();
  private readonly firstTokenCommitted = new Set<string>();
  private readonly firstTokenProjected = new Set<string>();
  private readonly activeOperationByConversation = new Map<string, string>();
  private submissionControlLine: Promise<void> = Promise.resolve();
  readonly projectionOutbox = new PiProjectionOutbox(
    this.ctx.storage.sql,
    (sequence, displayId, operationId, event) =>
      this.deliverEventProjection(sequence, displayId, operationId, event)
  );
  readonly repositoryDiffOutbox = new RepositoryDiffOutbox(this.ctx.storage.sql);
  readonly repositoryDiffPublication = new RepositoryDiffPublicationCapability(() =>
    this.drainRepositoryDiffPublication()
  );
  readonly harness = new PiHarness({
    harness: async ({ storage, context }) => {
      const snapshot = await readPiFeatureCapabilitySnapshot(this.ctx.storage);
      if (!snapshot) throw new Error("Pi Durable capability authority is not initialized");
      const { capabilities } = snapshot;
      const sessionContext = await this.fetchSessionContext("bootstrap");
      const currentCapabilities = async (signal?: AbortSignal) =>
        (await this.fetchCapabilityAuthorityForStoredSession(signal)).current.capabilities;
      const codeModeCoordinator = new PiCodeModeExecutionCoordinator();
      this.codeModeCoordinator = codeModeCoordinator;
      const codeModePolicy = createPiCodeModePolicyState({
        coordinator: codeModeCoordinator,
        // The nested-call restriction is durable: it survives an eviction.
        parents: createDurableCodeModeParentRegistry(this.ctx.storage),
        authorizeStart: async (signal) => {
          if ((await currentCapabilities(signal)).codeMode !== "enabled") {
            throw new Error("Code Mode is disabled for new calls by deployment policy");
          }
        },
      });
      const codeModePolicyDelegate = createPiCodeModePolicyDelegate(codeModePolicy);
      const sandboxExecutionPolicyDelegate = createSandboxExecutionPolicyDelegate();
      const emergencyPolicy = createPiDeploymentEmergencyPolicy(currentCapabilities);
      const core = createOpenInspectExtension({
        repositories: sessionContext.repositories,
        invokeRepository: (tool, args, signal) => this.invokeRepositoryTool(tool, args, signal),
      });
      const delegation = createSubagentExtension();
      const agentMessaging = createAgentMessagingExtension({
        invoke: (control, callerConversationId, signal) =>
          this.invokeAgentControl(control, callerConversationId as ConversationId, signal),
      });
      let workspacePolicyDelegate: PiToolPolicyDelegate | undefined;
      const workspaceMutations = new WorkspaceMutationFifo();
      const extensions: PiExtensionContribution[] = [
        {
          slot: "policy",
          effects: [],
          createExtension: (effects) => {
            const browserDelegate = createBrowserPolicyDelegate({
              client: {
                authorize: async (request, signal) => {
                  const decision = await this.authorizeBrowser(request, signal);
                  return decision;
                },
              },
            });
            const externalActionDelegate = createExternalActionPolicyDelegate({
              client: {
                prepare: (request, signal) => this.prepareExternalAction(request, signal),
                status: (actionId, signal) => this.externalActionStatus(actionId, signal),
                execute: (actionId, signal) => this.executeExternalAction(actionId, signal),
              },
              // Provider-specific tools are contributed to the external_actions
              // slot together with their canonical effect registrations.
              externalActions: {},
              // The live deployment mode gates only a new prepare. An effect
              // that is already prepared keeps its status and reconciliation
              // reachable, so an emergency deny cannot strand admitted work.
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
            return createPiToolPolicyExtension(
              effects,
              workspacePolicyDelegate
                ? [
                    externalActionDelegate,
                    browserDelegate,
                    workspacePolicyDelegate,
                    codeModePolicyDelegate,
                    sandboxExecutionPolicyDelegate,
                  ]
                : [
                    externalActionDelegate,
                    browserDelegate,
                    codeModePolicyDelegate,
                    sandboxExecutionPolicyDelegate,
                  ],
              emergencyPolicy
            );
          },
        },
        { slot: "core", extension: core, effects: declaredEffects(core) },
        {
          slot: "delegation",
          extension: delegation,
          effects: declaredEffects(delegation),
        },
        {
          slot: "external_actions",
          feature: "externalActions",
          minimumCapability: "enabled",
          extension: defineExtension({ name: "open-inspect.external-actions" }),
          effects: [],
        },
      ];
      if (sessionContext.agentMessagingEnabled) {
        extensions.push({
          slot: "agent_messaging",
          extension: agentMessaging,
          effects: declaredEffects(agentMessaging),
        });
      }
      if (sessionContext.skills && sessionContext.skills.skills.length > 0) {
        const skills = await createManagedSkillsExtension([
          skillSourceFromInstallation(sessionContext.skills),
        ]);
        extensions.push({
          slot: "skills",
          extension: skills,
          effects: declaredEffects(skills),
        });
      }
      const repositoryEditing =
        capabilities.repositoryEditing === "enabled" && sessionContext.repositories.length > 0;
      if (repositoryEditing) {
        const scratchWorkspace = createLazyWorkspaceToolFacade(() =>
          this.openWorkspace(capabilities.scratchWorkspace === "enabled")
        );
        this.workspace = scratchWorkspace;
        const repositoryWorkspace = createLazyWorkspaceToolFacade(async () => {
          await this.openWorkspace(capabilities.scratchWorkspace === "enabled");
          if (!this.rawWorkspace) throw new Error("Pi repository workspace is unavailable");
          return createWorkspaceToolFacade(this.rawWorkspace);
        });
        this.repositoryWorkspaceInitializer = async (signal) => {
          await this.openWorkspace(capabilities.scratchWorkspace === "enabled");
          return this.initializeRepositoryWorkspace(
            (await this.ensureRepositoryPins(signal)).repositories,
            workspaceMutations,
            signal
          );
        };
        const capability = createRepositoryEditingWorkspaceCapability({
          scratchWorkspace,
          repositoryWorkspace,
          initializeOverlay: (signal) => this.repositoryWorkspaceInitializer!(signal),
          mutations: workspaceMutations,
          scratchMode: capabilities.scratchWorkspace,
          publishDiff: (bundle) => this.publishDiffBundle(bundle),
          triggerMessageId: () => this.currentOperationId(),
        });
        workspacePolicyDelegate = capability.toolPolicyDelegate;
        extensions.push({
          slot: "scratch_workspace",
          feature: "repositoryEditing",
          minimumCapability: "enabled",
          extension: capability.extension,
          effects: capability.effects,
        });
        extensions.push({
          slot: "repository_editing",
          feature: "repositoryEditing",
          minimumCapability: "enabled",
          extension: defineExtension({ name: "open-inspect.repository-overlay" }),
          effects: [],
        });
      } else if (capabilities.scratchWorkspace !== "off") {
        const workspace = createLazyWorkspaceToolFacade(() =>
          this.openWorkspace(capabilities.scratchWorkspace === "enabled")
        );
        this.workspace = workspace;
        const capability = createComputerWorkspaceCapability(
          workspace,
          capabilities.scratchWorkspace,
          workspaceMutations
        );
        workspacePolicyDelegate = capability.toolPolicyDelegate;
        extensions.push({
          slot: "scratch_workspace",
          feature: "scratchWorkspace",
          minimumCapability: "read_only",
          extension: capability.extension,
          effects: capability.effects,
        });
      }
      if (capabilities.codeMode === "enabled") {
        const sandbox = await this.openCodemodeSandbox();
        extensions.push({
          slot: "code_mode",
          feature: "codeMode",
          minimumCapability: "enabled",
          extension: createOpenInspectCodemodeExtension(sandbox, codeModePolicy),
          effects: PI_CODEMODE_TOOL_EFFECT_REGISTRATIONS,
        });
      }
      if (capabilities.sandboxExecution === "enabled") {
        extensions.push({
          slot: "sandbox_execution",
          feature: "sandboxExecution",
          minimumCapability: "enabled",
          extension: createSandboxExecutionExtension({
            invoke: (request, signal) => this.invokeSandboxExecution(request, signal),
          }),
          effects: PI_SANDBOX_EXECUTION_TOOL_EFFECT_REGISTRATIONS,
        });
      }
      if (capabilities.crossSessionMessaging === "enabled") {
        extensions.push({
          slot: "cross_session",
          feature: "crossSessionMessaging",
          minimumCapability: "enabled",
          extension: createCrossSessionExtension({
            client: {
              send: (request, signal) => this.sendCrossSessionMessage(request, signal),
            },
          }),
          effects: CROSS_SESSION_TOOL_EFFECT_REGISTRATIONS,
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
      const assembly = assemblePiExtensions(extensions, capabilities);
      for (const extension of assembly.extensions) this.registry.install(extension);
      this.models.setProvider(openaiCodexProvider());
      const openStartedAt = Date.now();
      const opened = await Harness.open(
        storage,
        {
          models: this.models,
          registry: this.registry,
        },
        context
      );
      this.log.info("pi.latency", {
        event: "pi.latency",
        milestone: "pi_open",
        timestamp_ms: Date.now(),
        duration_ms: Date.now() - openStartedAt,
        cold: !this.harnessOpened,
      });
      this.harnessOpened = true;
      // A reopened harness keeps interrupted work pending but does not schedule
      // it until something asks for progress. Resuming here is what lets a
      // hibernated or evicted session continue a run it lost.
      this.wakeController = new PiHarnessWakeController({
        harness: opened,
        hasPendingWork: async () =>
          (await this.harness.pending({ session: ROOT_SESSION })).length > 0,
        nextDeadline: async () => null,
      });
      this.wakeController.resume();
      return opened;
    },
    defaults: {
      model: { provider: "openai-codex", id: "gpt-6.1-sol" },
      thinkingLevel: "low",
    },
  });
  readonly projector = new PiProjectionCapability({
    isPending: async (operationId) =>
      (await this.harness.pending({ session: ROOT_SESSION })).some(
        (operation) => operation.operationId === operationId
      ),
    probe: async (operationId) => {
      const result = await this.harness.wait(operationId, { session: ROOT_SESSION });
      return {
        status: result.status,
        ...(result.status === "unanswered" ? { reason: result.reason } : {}),
      };
    },
    finalize: (operationId) => this.captureFinalProjection(operationId),
    checkpoint: (operationId) => this.checkpointAccounting(operationId),
    drain: (operationId) => this.projectionOutbox.drain(operationId),
    result: (operationId) => this.waitForResult(operationId),
    deliver: async (sessionId, result) => {
      await this.stopEventRelay(result.operationId);
      // Stopping waits for the final live listener batch, which may have
      // enqueued after the projector's pre-terminal drain.
      await this.projectionOutbox.drain(result.operationId);
      await this.deliverResult(sessionId, result);
      this.projectionOutbox.complete(result.operationId);
      await this.settleOperationMetadata(result.operationId);
    },
    rejection: (operationId) => this.projectionOutbox.resultRejection(operationId),
    recordRejection: (operationId, error) =>
      this.projectionOutbox.markResultRejected(operationId, error.message),
    reject: async (operationId) => {
      this.projectionOutbox.complete(operationId);
      await this.settleOperationMetadata(operationId);
    },
    fail: async (sessionId, operationId, error) => {
      await this.stopEventRelay(operationId);
      await this.harness.abort({ session: ROOT_SESSION, operationId }).catch(() => false);
      const accounting = await this.observeOperationAccounting(operationId);
      const finalized = this.projectionOutbox.finalAccounting(operationId);
      await this.deliverResult(sessionId, {
        operationId,
        status: "unanswered",
        text: "",
        reason: error.message,
        usage: finalized?.usage ?? accounting.usage,
        costUsd: finalized?.costUsd ?? accounting.costUsd,
      });
      this.projectionOutbox.complete(operationId);
      await this.settleOperationMetadata(operationId);
    },
  });
  readonly lifecycle = Lifecycle.install(this)
    .use(this.harness)
    .use(this.projector)
    .use(this.repositoryDiffPublication);

  async initialize(sessionId: string, input: PiFeatureCapabilitySnapshot): Promise<void> {
    const initializeStartedAt = Date.now();
    const snapshot = piFeatureCapabilitySnapshotSchema.parse(input);
    await this.ctx.storage.transaction(async (transaction) => {
      if ((await transaction.get<string>(DELETION_STATE_KEY)) !== undefined) {
        throw new Error("Pi Durable session was deleted");
      }
      const [storedSessionId, storedSnapshotValue] = await Promise.all([
        transaction.get<string>(SESSION_ID_KEY),
        transaction.get<unknown>(PI_FEATURE_CAPABILITY_SNAPSHOT_KEY),
      ]);
      if (storedSessionId === undefined && storedSnapshotValue === undefined) {
        await transaction.put({
          [SESSION_ID_KEY]: sessionId,
          [PI_FEATURE_CAPABILITY_SNAPSHOT_KEY]: snapshot,
        });
        return;
      }
      if (storedSessionId !== sessionId) {
        throw new Error("Pi Durable Object session identity mismatch");
      }
      if (storedSnapshotValue === undefined) {
        throw new Error("Pi Durable Object capability snapshot mismatch");
      }
      const storedSnapshot = piFeatureCapabilitySnapshotSchema.parse(storedSnapshotValue);
      if (JSON.stringify(storedSnapshot) !== JSON.stringify(snapshot)) {
        throw new Error("Pi Durable Object capability snapshot mismatch");
      }
    });
    const initializedAt = Date.now();
    this.log.info("pi.latency", {
      event: "pi.latency",
      milestone: "pi_init",
      timestamp_ms: initializedAt,
      duration_ms: initializedAt - initializeStartedAt,
      session_id: sessionId,
      capability_workspace: snapshot.capabilities.scratchWorkspace,
      capability_repository_editing: snapshot.capabilities.repositoryEditing,
      capability_code_mode: snapshot.capabilities.codeMode,
      sandbox_avoided: 1,
    });
  }

  async onStart(): Promise<void> {
    if (await this.ctx.storage.get<string>(DELETION_STATE_KEY)) return;
    const sessionId = await this.ctx.storage.get<string>(SESSION_ID_KEY);
    if (!sessionId) return;
    await this.ensureSession(sessionId);
    const pending = await this.harness.pending({ session: ROOT_SESSION });
    // A hibernated object wakes with its harness closed over pending work but
    // no scheduler. Resume before reattaching relays so a run that lost its
    // instance continues.
    if (pending.length > 0) this.resumeHarness();
    const completionRecords = await this.ctx.storage.list<NativeControlCompletion>({
      prefix: CONTROL_COMPLETION_PREFIX,
    });
    await Promise.all([
      ...[...completionRecords.values()].map((record) => {
        this.ctx.waitUntil(this.resumeNativeControlCompletion(record));
        return Promise.resolve();
      }),
      ...pending.map((operation) =>
        this.startEventRelay(sessionId, operation.operationId, {
          recoverSnapshot: operation.status === "running",
        })
      ),
    ]);
  }

  /**
   * Resume the Pi scheduler after a reopen or a hibernation.
   *
   * `resume()` is idempotent and throws only after the harness closed, which
   * a deleting session reaches; a closed harness has nothing to resume.
   */
  private resumeHarness(): void {
    try {
      this.wakeController?.resume();
    } catch (error) {
      this.log.debug("pi.resume_skipped", {
        event: "pi.resume_skipped",
        error_type: error instanceof Error ? error.constructor.name : typeof error,
      });
    }
  }

  async submit(input: PiRuntimePrompt): Promise<PiRuntimeReceipt> {
    const submitStartedAt = Date.now();
    try {
      await this.ensureSession(input.sessionId);
      await this.configure(input);
      await this.ensureSession(input.sessionId);
      const baseline = await this.accountingTotals();
      await this.rememberOperation(input, baseline);
      await this.startEventRelay(input.sessionId, input.messageId);
      await this.projector.schedule({
        sessionId: input.sessionId,
        operationId: input.messageId,
      });
      await this.ensureSession(input.sessionId);
    } catch {
      await this.stopEventRelay(input.messageId).catch(() => {});
      return {
        operationId: input.messageId,
        accepted: false,
        rejected: "Pi Durable initialization failed",
      };
    }
    const receipt = await this.harness.submit(input.content, {
      session: ROOT_SESSION,
      operationId: input.messageId,
    });
    this.log.info("pi.latency", {
      event: "pi.latency",
      milestone: "pi_admitted",
      timestamp_ms: Date.now(),
      duration_ms: Date.now() - submitStartedAt,
      session_id: input.sessionId,
      operation_id: receipt.operationId,
      model: input.model,
      sandbox_avoided: 1,
      trace_id: piTraceId(receipt.operationId),
    });
    await this.telemetry.startSpan(
      {
        name: "pi.durable.submit",
        attributes: {
          "submission.type": "input",
          harness: "pi",
          execution_backend: "durable_object",
        },
      },
      async (span) => {
        span.setAttributes({ result: "placed" });
      }
    );
    return { operationId: receipt.operationId, accepted: receipt.accepted };
  }

  private async waitForResult(operationId: string): Promise<PiRuntimeResult> {
    const result = await this.harness.wait(operationId, { session: ROOT_SESSION });
    const accounting = this.projectionOutbox.finalAccounting(operationId);
    if (!accounting) throw new Error("Pi operation final projection is unavailable");
    return {
      operationId,
      status: result.status,
      text: result.status === "done" ? (result.text ?? "") : "",
      ...(result.status === "unanswered" ? { reason: result.reason } : {}),
      usage: accounting.usage,
      costUsd: accounting.costUsd,
    };
  }

  async lookup(sessionId: string, operationId: string): Promise<PiRuntimeOperationStatus> {
    await this.ensureSession(sessionId);
    const pending = (await this.harness.pending({ session: ROOT_SESSION })).find(
      (operation) => operation.operationId === operationId
    );
    if (pending) return { status: pending.status };
    const result = await this.harness.wait(operationId, { session: ROOT_SESSION });
    if (result.status === "unanswered" && result.reason === "not_found") {
      return { status: "not_found" };
    }
    const metadata = await this.operationMetadata(operationId);
    if (!metadata) throw new Error("Pi operation pricing metadata is unavailable");
    await this.captureFinalProjection(operationId);
    await this.projector.schedule({
      sessionId,
      operationId,
    });
    return {
      status: "settled",
      result: await this.waitForResult(operationId),
    };
  }

  async abort(sessionId: string, operationId?: string): Promise<boolean> {
    await this.ensureSession(sessionId);
    return this.harness.abort({ session: ROOT_SESSION, operationId });
  }

  async status(sessionId: string): Promise<{ busy: boolean; pending: number }> {
    await this.ensureSession(sessionId);
    const [busy, pending] = await Promise.all([
      this.harness.session(ROOT_SESSION).busy(),
      this.harness.pending({ session: ROOT_SESSION }),
    ]);
    return { busy, pending: pending.length };
  }

  async control(input: PiRuntimeControl): Promise<PiRuntimeControlResult> {
    await this.ensureSession(input.sessionId);
    const pi = await this.harness.pi();
    if (input.action === "list_conversations") {
      const page = await pi.commit((tx) => tx.scanConversations({}, 33), BACKGROUND_CONTEXT);
      if (page.items.length > 32) throw new Error("Pi conversation limit reached");
      return {
        requestId: input.requestId,
        state: "completed",
        result: page.items.map((record) => ({
          id: record.id,
          ...(record.parent
            ? { parent: { conversationId: record.parent.conversationId, at: record.parent.at } }
            : {}),
          ...(record.owner
            ? {
                owner: { conversationId: record.owner.conversationId, taskId: record.owner.taskId },
              }
            : {}),
        })) as unknown as JsonValue,
      };
    }
    if (input.action === "inspect") {
      const inspection = await pi.inspect(BACKGROUND_CONTEXT);
      return {
        requestId: input.requestId,
        state: "completed",
        result: sanitizeInspection(inspection),
      };
    }
    if (input.action === "inspect_agents") {
      return {
        requestId: input.requestId,
        state: "completed",
        result: await this.inspectAgents(pi),
      };
    }
    if (input.action === "task_graph") {
      const graph = await pi.taskGraph(BACKGROUND_CONTEXT);
      try {
        return {
          requestId: input.requestId,
          state: "completed",
          result: graph.value as unknown as JsonValue,
        };
      } finally {
        graph.dispose();
      }
    }
    if (input.action === "cancel_agent") {
      const task = await pi.getTask(input.taskId as TaskId, BACKGROUND_CONTEXT);
      if (!task) throw new Error("Pi agent task not found");
      const child = await pi.commit(
        (tx) => tx.conversation(task.conversationId),
        BACKGROUND_CONTEXT
      );
      if (!child?.owner) throw new Error("Pi agent cancellation requires a child conversation");
      const outcome = await pi.abortTask(input.taskId as TaskId, BACKGROUND_CONTEXT);
      return { requestId: input.requestId, state: "completed", result: { outcome } };
    }
    const conversation = await this.controlConversation(
      pi,
      "conversationId" in input ? input.conversationId : undefined
    );
    if (input.action === "get_conversation") {
      const page = await conversation.entries({}, 200, undefined, BACKGROUND_CONTEXT);
      return {
        requestId: input.requestId,
        state: "completed",
        result: {
          id: conversation.id,
          entries: page.items.map((entry) => ({
            id: entry.id,
            kind: entry.kind,
            ...(entry.byTaskId === undefined ? {} : { taskId: entry.byTaskId }),
          })),
        } as unknown as JsonValue,
      };
    }
    if (input.action === "get_last_message") {
      return {
        requestId: input.requestId,
        state: "completed",
        result: lastAgentMessage(
          await conversation.entries({}, 200, undefined, BACKGROUND_CONTEXT),
          2_000
        ),
      };
    }
    if (input.action === "cancel_exact") {
      if (input.operationId) {
        const operationId = input.operationId;
        const matched = (await pi.inspect(BACKGROUND_CONTEXT)).submissions.find(
          (submission) =>
            (submission.requestId === operationId ||
              submission.requestId === nativeControlSubmissionRequestId(operationId)) &&
            (!input.conversationId || submission.conversationId === input.conversationId)
        );
        if (!matched)
          return {
            requestId: input.requestId,
            state: "completed",
            result: { outcome: "not_found" },
          };
        const outcome = await pi.abortSubmission(
          matched.id,
          BACKGROUND_CONTEXT,
          input.conversationId as ConversationId | undefined
        );
        return { requestId: input.requestId, state: "completed", result: { outcome } };
      }
      if (input.submissionId) {
        const outcome = await pi.abortSubmission(
          input.submissionId as SubmissionId,
          BACKGROUND_CONTEXT,
          input.conversationId as ConversationId | undefined
        );
        return { requestId: input.requestId, state: "completed", result: { outcome } };
      }
      if (input.taskId) {
        const outcome = await pi.abortTask(input.taskId as TaskId, BACKGROUND_CONTEXT);
        return { requestId: input.requestId, state: "completed", result: { outcome } };
      }
      throw new Error("Exact Pi cancel target is required");
    }
    if (input.action === "reset" || input.action === "handoff") {
      await conversation.reset(
        input.action === "handoff" ? input.handoff : undefined,
        BACKGROUND_CONTEXT
      );
      return {
        requestId: input.requestId,
        state: "completed",
        result: { conversationId: conversation.id },
      };
    }
    if (input.action === "compact") {
      if ((await pi.inspect(BACKGROUND_CONTEXT)).tasks.length >= 4)
        throw new Error("Pi active task limit reached");
      const baseline = await this.accountingTotals();
      const taskId = await conversation.compact(input.instructions, BACKGROUND_CONTEXT);
      await this.scheduleNativeControlCompletion({
        sessionId: input.sessionId,
        requestId: input.requestId,
        baseline,
        suppressCost: false,
        target: { kind: "task", id: taskId },
      });
      return {
        requestId: input.requestId,
        state: "accepted",
        result: { conversationId: conversation.id, taskId },
      };
    }
    if (input.action === "fork") {
      const all = await pi.commit((tx) => tx.scanConversations({}, 33), BACKGROUND_CONTEXT);
      if (all.items.length >= 32) throw new Error("Pi conversation limit reached");
      const source = all.items.find((record) => record.id === input.conversationId);
      if (!source) throw new Error("Pi conversation not found");
      if (source.parent || source.owner) throw new Error("Pi fork depth limit reached");
      const forkExtensions = (await conversation.agent(BACKGROUND_CONTEXT)).extensions.filter(
        (extension) =>
          extension.name !== SUBAGENT_EXTENSION_NAME &&
          extension.name !== AGENT_MESSAGING_EXTENSION_NAME
      );
      const fork = await conversation.fork(
        input.entryId as EntryId,
        { ownership: { kind: "ownerless" }, agent: { extensions: forkExtensions } },
        BACKGROUND_CONTEXT
      );
      return {
        requestId: input.requestId,
        state: "completed",
        result: { conversationId: fork.id },
      };
    }
    if (!(
      input.action === "submit" ||
      input.action === "send" ||
      input.action === "steer" ||
      input.action === "follow_up"
    ))
      throw new Error("Unsupported Pi control action");
    return this.onSubmissionControlLine(async () => {
      const inspection = await pi.inspect(BACKGROUND_CONTEXT);
      if (inspection.tasks.length >= 4) throw new Error("Pi active task limit reached");
      const conversationBusy =
        inspection.tasks.some((task) => task.record.conversationId === conversation.id) ||
        inspection.submissions.some(
          (submission) =>
            submission.conversationId === conversation.id && submission.status === "placed"
        );
      const pendingMessages = inspection.submissions.filter(
        (submission) =>
          submission.conversationId === conversation.id &&
          (submission.status === "queued" || submission.status === "placed")
      ).length;
      if (pendingMessages >= MAX_PENDING_AGENT_MESSAGES)
        throw new Error("Pi agent message limit reached");
      if (input.action === "steer" && !conversationBusy)
        throw new Error("Pi conversation is not active");
      if (
        (input.action === "steer" || input.action === "follow_up") &&
        (input.model !== undefined || input.reasoningEffort !== undefined)
      )
        throw new Error("Busy Pi controls cannot change model configuration");
      if (
        (input.action === "submit" || input.action === "send") &&
        (input.model !== undefined || input.reasoningEffort !== undefined)
      ) {
        const busy =
          inspection.tasks.length > 0 ||
          inspection.submissions.some((submission) => submission.status === "placed");
        if (busy) throw new Error("Pi model configuration is bound to an active submission");
        const model = input.model ? toPiModel(input.model) : undefined;
        const thinking = toPiThinkingLevel(input.reasoningEffort);
        await conversation.configure(
          {
            ...(model ? { model: { provider: model.provider, modelId: model.id } } : {}),
            ...(thinking === undefined ? {} : { thinkingLevel: thinking }),
          },
          BACKGROUND_CONTEXT
        );
      }
      const whenBusy =
        input.action === "steer" ? "steer" : input.action === "follow_up" ? "followUp" : "reject";
      const baseline = await this.accountingTotals();
      const submission = await conversation.submit(
        {
          type: "input",
          content: input.content,
          requestId: nativeControlSubmissionRequestId(input.requestId),
          whenBusy,
        },
        BACKGROUND_CONTEXT
      );
      await this.scheduleNativeControlCompletion({
        sessionId: input.sessionId,
        requestId: input.requestId,
        baseline,
        suppressCost: input.action === "steer" || input.action === "follow_up",
        target: { kind: "submission", id: submission.id },
      });
      return {
        requestId: input.requestId,
        state: "accepted",
        result: { conversationId: conversation.id, submissionId: submission.id },
      };
    });
  }

  private onSubmissionControlLine<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.submissionControlLine.catch(() => undefined).then(operation);
    this.submissionControlLine = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async scheduleNativeControlCompletion(record: NativeControlCompletion): Promise<void> {
    await this.ctx.storage.put(`${CONTROL_COMPLETION_PREFIX}${record.requestId}`, record);
    this.ctx.waitUntil(this.resumeNativeControlCompletion(record));
  }

  private async resumeNativeControlCompletion(record: NativeControlCompletion): Promise<void> {
    const pi = await this.harness.pi();
    let status: "completed" | "failed";
    if (record.target.kind === "submission") {
      const submission = await pi.submission(record.target.id as SubmissionId, BACKGROUND_CONTEXT);
      if (!submission) throw new Error("Pi control submission is unavailable");
      const settled = await submission.wait(BACKGROUND_CONTEXT);
      status = settled.status === "done" ? "completed" : "failed";
    } else {
      const task = await pi.waitForTask(record.target.id as TaskId, BACKGROUND_CONTEXT);
      status = task.state.outcome.status === "completed" ? "completed" : "failed";
    }
    const current = await this.accountingTotals();
    const accounting = record.suppressCost
      ? { costUsd: 0 }
      : operationAccountingDelta(current, {
          usage: record.baseline.usage,
          costUsd: record.baseline.costUsd,
        });
    const response = await this.env.SESSION.getByName(record.sessionId).fetch(
      new Request(`http://session${SessionInternalPaths.piControlCompletion}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: record.requestId, status, costUsd: accounting.costUsd }),
      })
    );
    if (!response.ok && response.status !== 404)
      throw new Error(`Pi control completion rejected (${response.status})`);
    await this.ctx.storage.delete(`${CONTROL_COMPLETION_PREFIX}${record.requestId}`);
  }

  private async controlConversation(
    pi: Awaited<ReturnType<PiSessionDO["harness"]["pi"]>>,
    conversationId?: number
  ) {
    if (!conversationId) return pi.root(BACKGROUND_CONTEXT);
    const conversation = await pi.conversation(
      conversationId as ConversationId,
      BACKGROUND_CONTEXT
    );
    if (!conversation) throw new Error("Pi conversation not found");
    return conversation;
  }

  private async inspectAgents(
    pi: Awaited<ReturnType<PiSessionDO["harness"]["pi"]>>
  ): Promise<JsonValue> {
    const [page, inspection] = await Promise.all([
      pi.commit((tx) => tx.scanConversations({}, 33), BACKGROUND_CONTEXT),
      pi.inspect(BACKGROUND_CONTEXT),
    ]);
    if (page.items.length > 32) throw new Error("Pi conversation limit reached");
    const agents = await Promise.all(
      page.items.map(async (record) => {
        const conversation = await pi.conversation(record.id, BACKGROUND_CONTEXT);
        if (!conversation) throw new Error("Pi conversation not found");
        const view = await conversation.viewState(BACKGROUND_CONTEXT);
        try {
          const tasks = inspection.tasks
            .filter((task) => task.record.conversationId === record.id)
            .slice(0, 16)
            .map((task) => ({
              id: task.record.id,
              kind: task.record.kind,
              status: task.state.kind,
              phase: "phase" in task.record.state ? task.record.state.phase : undefined,
              abortRequested: task.record.abortRequested,
            }));
          const queued = inspection.submissions.filter(
            (submission) =>
              submission.conversationId === record.id && submission.status === "queued"
          ).length;
          const placed = inspection.submissions.filter(
            (submission) =>
              submission.conversationId === record.id && submission.status === "placed"
          ).length;
          const usage = summarizePiUsage(view.value.docs["pi.usage"] as unknown as UsageState);
          return {
            conversationId: record.id,
            ...(record.parent
              ? {
                  parent: {
                    conversationId: record.parent.conversationId,
                    entryId: record.parent.at,
                  },
                }
              : {}),
            ...(record.owner
              ? {
                  owner: {
                    conversationId: record.owner.conversationId,
                    taskId: record.owner.taskId,
                  },
                }
              : {}),
            status: tasks.length > 0 || placed > 0 ? "active" : queued > 0 ? "queued" : "idle",
            queued,
            tasks,
            usage,
            lastEntryId: latestAssistantEntryId(view.value.entries),
          };
        } finally {
          view.dispose();
        }
      })
    );
    return { agents } as unknown as JsonValue;
  }

  async destroy(sessionId: string): Promise<void> {
    if ((await this.ctx.storage.get<string>(DELETION_STATE_KEY)) === "destroyed") return;
    await this.ctx.blockConcurrencyWhile(async () => {
      const deletionState = await this.ctx.storage.get<string>(DELETION_STATE_KEY);
      if (deletionState === "destroyed") return;
      const stored = await this.ctx.storage.get<string>(SESSION_ID_KEY);
      if (stored !== undefined && stored !== sessionId) {
        throw new Error("Pi Durable Object session identity mismatch");
      }
      if (stored === undefined) await this.ctx.storage.put(SESSION_ID_KEY, sessionId);
      const opening = this.eventStreamOpening;
      this.eventStreamOpening = undefined;
      if (opening) await opening.then((stream) => stream.stop()).catch(() => {});
      if (this.eventStream) {
        await this.eventStream.stop();
        this.eventStream = undefined;
      }
      await this.eventRouterWork.catch(() => {});
      this.projectedOperations.clear();
      this.translationStateByOperation.clear();
      this.eventRelayWork.clear();
      if (deletionState !== "destroying") {
        await this.ctx.storage.put(DELETION_STATE_KEY, "destroying");
        // A cold object has no live code to abort. Opening its harness here can
        // require repository rematerialization and make deletion depend on an
        // external provider that may be unavailable or revoked.
        if (this.harnessOpened) await this.harness.abort({ session: ROOT_SESSION });
      }
      await this.lifecycle.disableAlarms();
      this.repositoryWorkspaceAbort.abort(new Error("Pi Durable session was deleted"));
      if (this.harnessOpened) await this.harness.dispose();
      this.harnessOpened = false;
      const codeModeDrain = this.codeModeCoordinator?.close(
        new Error("Pi Durable session was deleted")
      );
      await this.codemodeSandbox?.close();
      await codeModeDrain;
      this.codeModeCoordinator = undefined;
      this.codemodeSandbox = undefined;
      await this.rawWorkspace?.close();
      this.workspace = undefined;
      this.rawWorkspace = undefined;
      this.repositoryWorkspace = undefined;
      this.repositoryWorkspaceInitialization = undefined;
      this.repositoryWorkspaceInitializer = undefined;
      this.credentials.clear();
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.put(DELETION_STATE_KEY, "destroyed");
    });
  }

  async refreshDiff(sessionId: string): Promise<void> {
    await this.ensureSession(sessionId);
    const snapshot = await readPiFeatureCapabilitySnapshot(this.ctx.storage);
    if (!snapshot || snapshot.capabilities.repositoryEditing !== "enabled") {
      throw new Error("Pi repository editing is not enabled");
    }
    await this.harness.pi();
    if (!this.repositoryWorkspaceInitializer)
      throw new Error("Pi repository editing is not enabled");
    await this.repositoryWorkspaceInitializer();
    await this.repositoryDiffOutbox.requestRecapture();
    await this.repositoryDiffPublication.schedule();
  }

  private async openWorkspace(writable: boolean): Promise<WorkspaceToolFacade> {
    if (this.rawWorkspace && this.workspace) return this.workspace;
    const workspace = new Workspace({
      storage: this.ctx.storage as unknown as DurableObjectStorageLike,
      sessionId: this.ctx.id.toString(),
    });
    try {
      await ensureRealWorkspaceDirectory(workspace.fs, "/workspace");
      await ensureRealWorkspaceDirectory(workspace.fs, COMPUTER_SCRATCH_ROOT);
      await ensureRealWorkspaceDirectory(workspace.fs, "/workspace/repos");
    } catch (error) {
      await workspace.close().catch(() => {});
      throw error;
    }
    this.rawWorkspace = workspace;
    this.workspace = writable
      ? createQuotaWorkspace(workspace, this.ctx.storage)
      : createWorkspaceToolFacade(workspace);
    return this.workspace;
  }

  private async initializeRepositoryWorkspace(
    repositories: Array<PiSessionContext["repositories"][number] & { commitSha: string }>,
    mutations: WorkspaceMutationFifo,
    signal?: AbortSignal
  ): Promise<PiRepositoryWorkspace> {
    if (signal?.aborted)
      throw signal.reason ?? new Error("Repository overlay initialization aborted");
    if (this.repositoryWorkspace) return this.repositoryWorkspace;
    if (!this.repositoryWorkspaceInitialization) {
      const startedAt = Date.now();
      let providerRequests = 0;
      const work = (async () => {
        const rawWorkspace = this.rawWorkspace;
        if (!rawWorkspace) throw new Error("Pi repository workspace is unavailable");
        const repositoryWorkspace = new PiRepositoryWorkspace(rawWorkspace.fs, () => Date.now(), {
          mutations,
          publication: {
            stage: (bundle) => this.repositoryDiffOutbox.stage(bundle),
            drain: () => this.drainRepositoryDiffOutbox(),
            recordCaptureFailure: (error) =>
              this.repositoryDiffOutbox.recordCaptureFailure(error).then(() => undefined),
            recordFailure: (error) => this.repositoryDiffOutbox.recordFailure(error),
            reportFailure: async (error) => {
              const sessionId = await this.ctx.storage.get<string>(SESSION_ID_KEY);
              if (sessionId) {
                await this.recordDiffFailure(
                  sessionId,
                  error instanceof Error ? error.message : String(error)
                ).catch(() => {});
              }
            },
            schedule: () => this.repositoryDiffPublication.schedule(),
          },
        });
        const restorePlan = await repositoryWorkspace.restore(repositories);
        const manifests: PiRepositoryMaterializationManifest[] = [];
        for (const repository of repositories) {
          if (!restorePlan.materializePositions.includes(repository.position)) continue;
          providerRequests += 1;
          manifests.push(
            await this.fetchRepositoryMaterializationManifest(
              repository.position,
              repository.commitSha,
              this.repositoryWorkspaceAbort.signal
            )
          );
        }
        const materializations = [];
        for (const manifest of manifests) {
          materializations.push(
            await this.fetchRepositoryMaterialization(
              manifest,
              () => {
                providerRequests += 1;
              },
              this.repositoryWorkspaceAbort.signal
            )
          );
        }
        await repositoryWorkspace.materialize(materializations);
        this.repositoryWorkspace = repositoryWorkspace;
        console.log(
          JSON.stringify({
            event: "pi.repository_overlay.init",
            outcome: "success",
            duration_ms: Date.now() - startedAt,
            files: materializations.reduce((sum, item) => sum + item.files.length, 0),
            provider_requests: providerRequests,
          })
        );
        return repositoryWorkspace;
      })();
      this.repositoryWorkspaceInitialization = work;
      void work
        .catch((error) => {
          console.warn(
            JSON.stringify({
              event: "pi.repository_overlay.init",
              outcome: "failure",
              duration_ms: Date.now() - startedAt,
              provider_requests: providerRequests,
              error: error instanceof Error ? error.message : String(error),
            })
          );
        })
        .finally(() => {
          if (this.repositoryWorkspaceInitialization === work && !this.repositoryWorkspace) {
            this.repositoryWorkspaceInitialization = undefined;
          }
        });
    }
    return awaitWithAbort(this.repositoryWorkspaceInitialization, signal);
  }

  private async openCodemodeSandbox(): Promise<RemoteCodemodeSandbox> {
    if (this.codemodeSandbox) return this.codemodeSandbox;
    const namespace = this.env.CODEMODE_SANDBOX;
    if (!namespace) throw new Error("Code Mode sandbox binding is unavailable");
    const sessionId = await this.ctx.storage.get<string>(SESSION_ID_KEY);
    if (!sessionId) throw new Error("Pi Durable session is not initialized");
    const sandbox = new RemoteCodemodeSandbox({
      remote: () => namespace.getByName(sessionId),
    });
    this.codemodeSandbox = sandbox;
    return sandbox;
  }

  private async configure(
    input: Pick<PiRuntimePrompt, "model" | "reasoningEffort" | "requirePricing">
  ): Promise<void> {
    const pi = await this.harness.pi();
    const conversation = await pi.root(BACKGROUND_CONTEXT);
    const model = toPiModel(input.model);
    const thinkingLevel = toPiThinkingLevel(input.reasoningEffort);
    await conversation.configure(
      {
        model: { provider: model.provider, modelId: model.id },
        ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
      },
      BACKGROUND_CONTEXT
    );
    if (input.requirePricing) this.requirePricedModel(input.model);
  }

  private requirePricedModel(modelId: string): void {
    if (!hasTrustedPiPricing(this.models, modelId)) {
      throw new Error(`Pi model ${modelId} has no trusted server pricing`);
    }
  }

  private async rememberOperation(
    input: Pick<PiRuntimePrompt, "messageId" | "model">,
    baseline: PiAccountingSnapshot
  ): Promise<void> {
    const key = `${OPERATION_METADATA_PREFIX}${input.messageId}`;
    const existing = await this.ctx.storage.get<PiOperationMetadata>(key);
    if (existing) {
      if (existing.model !== input.model) throw new Error("Pi operation model mismatch");
      return;
    }
    await this.ctx.storage.put(key, {
      model: input.model,
      baseline,
      projectedCostUsd: 0,
    });
  }

  private operationMetadata(operationId: string): Promise<PiOperationMetadata | undefined> {
    return this.ctx.storage.get<PiOperationMetadata>(`${OPERATION_METADATA_PREFIX}${operationId}`);
  }

  private async settleOperationMetadata(operationId: string): Promise<void> {
    this.firstModelRequestObserved.delete(operationId);
    this.firstTokenCommitted.delete(operationId);
    this.firstTokenProjected.delete(operationId);
    const key = `${OPERATION_METADATA_PREFIX}${operationId}`;
    const metadata = await this.ctx.storage.get<PiOperationMetadata>(key);
    if (!metadata) return;
    await this.ctx.storage.put(key, { ...metadata, settledAt: Date.now() });
    const entries = await this.ctx.storage.list<PiOperationMetadata>({
      prefix: OPERATION_METADATA_PREFIX,
    });
    const expired = [...entries.entries()]
      .filter((entry): entry is [string, PiOperationMetadata & { settledAt: number }] =>
        Number.isFinite(entry[1].settledAt)
      )
      .sort(
        (left, right) => right[1].settledAt - left[1].settledAt || right[0].localeCompare(left[0])
      )
      .slice(MAX_OPERATION_METADATA_TOMBSTONES);
    if (expired.length > 0) await this.ctx.storage.delete(expired.map(([storedKey]) => storedKey));
  }

  private async accountingTotals(): Promise<PiAccountingSnapshot> {
    return summarizePiUsage(await (await this.harness.pi()).usage(BACKGROUND_CONTEXT));
  }

  private async observeOperationAccounting(
    operationId: string
  ): Promise<PiAccountingSnapshot & { changed: boolean }> {
    const current = await this.accountingTotals();
    const key = `${OPERATION_METADATA_PREFIX}${operationId}`;
    const metadata = await this.ctx.storage.get<PiOperationMetadata>(key);
    if (!metadata) throw new Error("Pi operation accounting metadata is unavailable");
    const delta = operationAccountingDelta(current, {
      usage: metadata.baseline.usage,
      costUsd: metadata.baseline.costUsd,
    });
    const costUsd = Math.max(metadata.projectedCostUsd, delta.costUsd);
    return { usage: delta.usage, costUsd, changed: costUsd > metadata.projectedCostUsd };
  }

  private async recordProjectedCost(operationId: string, costUsd: number): Promise<void> {
    const key = `${OPERATION_METADATA_PREFIX}${operationId}`;
    await this.ctx.storage.transaction(async (transaction) => {
      const metadata = await transaction.get<PiOperationMetadata>(key);
      if (!metadata) throw new Error("Pi operation accounting metadata is unavailable");
      if (costUsd > metadata.projectedCostUsd) {
        await transaction.put(key, { ...metadata, projectedCostUsd: costUsd });
      }
    });
  }

  private async ensureSession(sessionId: string): Promise<void> {
    if (await this.ctx.storage.get<string>(DELETION_STATE_KEY)) {
      throw new Error("Pi Durable session was deleted");
    }
    const [storedSessionId, storedSnapshotValue] = await Promise.all([
      this.ctx.storage.get<string>(SESSION_ID_KEY),
      this.ctx.storage.get<unknown>(PI_FEATURE_CAPABILITY_SNAPSHOT_KEY),
    ]);
    if (storedSessionId !== undefined && storedSessionId !== sessionId) {
      throw new Error("Pi Durable Object session identity mismatch");
    }
    if (storedSessionId !== undefined && storedSnapshotValue !== undefined) {
      piFeatureCapabilitySnapshotSchema.parse(storedSnapshotValue);
      return;
    }
    if (storedSessionId === undefined && storedSnapshotValue !== undefined) {
      throw new Error("Pi Durable Object session identity mismatch");
    }

    const authority = await this.fetchCapabilityAuthority(sessionId);
    const authoritativeSnapshot = authority.snapshot ?? PI_LEGACY_FEATURE_CAPABILITY_SNAPSHOT;
    await this.ctx.storage.transaction(async (transaction) => {
      if ((await transaction.get<string>(DELETION_STATE_KEY)) !== undefined) {
        throw new Error("Pi Durable session was deleted");
      }
      const [storedSessionId, storedSnapshotValue] = await Promise.all([
        transaction.get<string>(SESSION_ID_KEY),
        transaction.get<unknown>(PI_FEATURE_CAPABILITY_SNAPSHOT_KEY),
      ]);
      if (storedSessionId === undefined) {
        if (storedSnapshotValue !== undefined) {
          throw new Error("Pi Durable Object session identity mismatch");
        }
        await transaction.put({
          [SESSION_ID_KEY]: sessionId,
          [PI_FEATURE_CAPABILITY_SNAPSHOT_KEY]: authoritativeSnapshot,
        });
        return;
      }
      if (storedSessionId !== sessionId) {
        throw new Error("Pi Durable Object session identity mismatch");
      }
      if (storedSnapshotValue === undefined) {
        await transaction.put(PI_FEATURE_CAPABILITY_SNAPSHOT_KEY, authoritativeSnapshot);
        return;
      }
      const storedSnapshot = piFeatureCapabilitySnapshotSchema.parse(storedSnapshotValue);
      if (JSON.stringify(storedSnapshot) !== JSON.stringify(authoritativeSnapshot)) {
        throw new Error("Pi Durable Object capability snapshot mismatch");
      }
    });
  }

  private async fetchCapabilityAuthorityForStoredSession(signal?: AbortSignal) {
    const sessionId = await this.ctx.storage.get<string>(SESSION_ID_KEY);
    if (!sessionId) throw new Error("Pi Durable session is not initialized");
    return this.fetchCapabilityAuthority(sessionId, signal);
  }

  private fetchCapabilityAuthority(sessionId: string, signal?: AbortSignal) {
    return fetchPiCapabilityAuthority(this.env.SESSION.getByName(sessionId), signal);
  }

  private async fetchCodexCredential(rejectedCredentialVersion?: number, signal?: AbortSignal) {
    const brokerStartedAt = Date.now();
    if (await this.ctx.storage.get<string>(DELETION_STATE_KEY)) {
      throw new Error("Pi Durable session was deleted");
    }
    const sessionId = await this.ctx.storage.get<string>(SESSION_ID_KEY);
    if (!sessionId) throw new Error("Pi Durable session is not initialized");
    const operationId = await this.attributedOperationId(ROOT_SESSION);
    if (!operationId) throw new Error("Pi Durable has no attributed active operation");
    const stub = this.env.SESSION.getByName(sessionId);
    const response = await stub.fetch(
      new Request(`http://session${SessionInternalPaths.piCredential}`, {
        method: "POST",
        headers: {
          "X-Pi-Operation-ID": operationId,
          ...piTraceHeader(operationId ?? undefined),
          ...(rejectedCredentialVersion === undefined
            ? {}
            : { "X-Pi-Rejected-Credential-Version": String(rejectedCredentialVersion) }),
        },
        signal,
      })
    );
    if (!response.ok) {
      throw new Error(`OpenAI credential broker failed (${response.status})`);
    }
    const body: unknown = await response.json();
    if (
      typeof body !== "object" ||
      body === null ||
      !("access_token" in body) ||
      typeof body.access_token !== "string" ||
      !("expires_in" in body) ||
      typeof body.expires_in !== "number" ||
      !("credential_version" in body) ||
      typeof body.credential_version !== "number"
    ) {
      throw new Error("Invalid OpenAI credential broker response");
    }
    const brokerCompletedAt = Date.now();
    this.log.info("pi.latency", {
      event: "pi.latency",
      milestone: "provider_broker",
      timestamp_ms: brokerCompletedAt,
      duration_ms: brokerCompletedAt - brokerStartedAt,
      session_id: sessionId,
      operation_id: operationId,
      recovery: rejectedCredentialVersion === undefined ? 0 : 1,
    });
    return {
      accessToken: body.access_token,
      expiresIn: body.expires_in,
      credentialVersion: body.credential_version,
    };
  }

  private async fetchSessionContext(
    mode: "bootstrap" | "pin",
    repositoryPins?: z.infer<typeof piRepositoryPinsSchema>
  ): Promise<PiSessionContext> {
    if (await this.ctx.storage.get<string>(DELETION_STATE_KEY)) {
      throw new Error("Pi Durable session was deleted");
    }
    const sessionId = await this.ctx.storage.get<string>(SESSION_ID_KEY);
    if (!sessionId) throw new Error("Pi Durable session is not initialized");
    const response = await this.env.SESSION.getByName(sessionId).fetch(
      new Request(`http://session${SessionInternalPaths.piContext}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, ...(repositoryPins ? { repositoryPins } : {}) }),
      })
    );
    if (!response.ok) throw new Error(`Pi session context unavailable (${response.status})`);
    return piSessionContextSchema.parse(await response.json());
  }

  private async ensureRepositoryPins(signal?: AbortSignal): Promise<{
    repositories: Array<PiSessionContext["repositories"][number] & { commitSha: string }>;
    skills: PiSessionContext["skills"];
  }> {
    const storedValue = await this.ctx.storage.get<unknown>(REPOSITORY_PINS_KEY);
    const stored =
      storedValue === undefined ? undefined : piRepositoryPinsSchema.parse(storedValue);
    const candidate = await this.fetchSessionContext("pin", stored);
    const pinned = candidate.repositories.map((repository) => {
      if (!repository.commitSha) throw new Error("Pi repository pin is unavailable");
      return { ...repository, commitSha: repository.commitSha };
    });
    signal?.throwIfAborted();
    await this.ctx.storage.transaction(async (transaction) => {
      const winnerValue = await transaction.get<unknown>(REPOSITORY_PINS_KEY);
      if (winnerValue === undefined) {
        await transaction.put(
          REPOSITORY_PINS_KEY,
          pinned.map(({ repoOwner, repoName, position, commitSha }) => ({
            repoOwner,
            repoName,
            position,
            commitSha,
          }))
        );
        return;
      }
      const winner = piRepositoryPinsSchema.parse(winnerValue);
      if (
        JSON.stringify(winner) !==
        JSON.stringify(
          pinned.map(({ repoOwner, repoName, position, commitSha }) => ({
            repoOwner,
            repoName,
            position,
            commitSha,
          }))
        )
      ) {
        throw new Error("Pi repository pin does not match the immutable winner");
      }
    });
    return { repositories: pinned, skills: candidate.skills };
  }

  private async invokeRepositoryTool(
    tool: "repository_list" | "repository_read",
    args: Record<string, JsonValue | undefined>,
    signal?: AbortSignal
  ) {
    const sessionId = await this.ctx.storage.get<string>(SESSION_ID_KEY);
    if (!sessionId) throw new Error("Pi Durable session is not initialized");
    const operationId = await this.attributedOperationId(ROOT_SESSION);
    if (!operationId) throw new Error("Pi Durable has no attributed active operation");
    const pins = await this.ensureRepositoryPins(signal);
    const position = typeof args.repository === "number" ? args.repository : 0;
    const repository = pins.repositories.find((candidate) => candidate.position === position);
    if (!repository) throw new Error(`Repository index ${position} is not part of this session`);
    const response = await this.env.SESSION.getByName(sessionId).fetch(
      new Request(`http://session${SessionInternalPaths.piRepositoryTool}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Pi-Operation-ID": operationId,
          ...piTraceHeader(operationId),
        },
        body: JSON.stringify({ tool, arguments: { ...args, commitSha: repository.commitSha } }),
        signal,
      })
    );
    const body: unknown = await response.json();
    if (!response.ok) {
      const message =
        typeof body === "object" &&
        body !== null &&
        "error" in body &&
        typeof body.error === "string"
          ? body.error
          : `Repository tool failed (${response.status})`;
      throw new Error(message);
    }
    return z.json().parse(body);
  }

  /**
   * Read one reviewed MCP tool through the owning session.
   *
   * The session resolves the grant, the reviewed catalog, and the owner's
   * identity. The agent never holds a credential and never names one.
   */
  private async readMcpTool(
    request: { connectionId: string; toolName: string; arguments: Record<string, unknown> },
    signal?: AbortSignal
  ): Promise<McpReadResult> {
    const sessionId = await this.ctx.storage.get<string>(SESSION_ID_KEY);
    if (!sessionId) throw new Error("Pi Durable session is not initialized");
    const operationId = await this.attributedOperationId(ROOT_SESSION);
    if (!operationId) throw new Error("Pi Durable has no attributed active operation");
    const response = await this.env.SESSION.getByName(sessionId).fetch(
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
  }> {
    const sessionId = await this.ctx.storage.get<string>(SESSION_ID_KEY);
    if (!sessionId) throw new Error("Pi Durable session is not initialized");
    const response = await this.env.SESSION.getByName(sessionId).fetch(
      new Request(`http://session${SessionInternalPaths.piMcpList}`, {
        method: "GET",
        ...(signal ? { signal } : {}),
      })
    );
    const body = await response.json().catch(() => null);
    if (!response.ok) return { grants: [] };
    const parsed = mcpSessionPinListSchema.safeParse(body);
    return parsed.success
      ? {
          grants: parsed.data.pins.map((pin) => ({
            connectionId: pin.connectionId,
            serverName: pin.serverName,
            toolNames: pin.toolNames,
          })),
        }
      : { grants: [] };
  }

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
    const sessionId = await this.ctx.storage.get<string>(SESSION_ID_KEY);
    if (!sessionId) throw new Error("Pi Durable session is not initialized");
    const operationId = await this.attributedOperationId(ROOT_SESSION);
    if (!operationId) throw new Error("Pi Durable has no attributed active operation");
    const response = await this.env.SESSION.getByName(sessionId).fetch(
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

  private async invokeSandboxExecution(
    request: SandboxExecutionToolRequest,
    signal?: AbortSignal
  ): Promise<SandboxExecutionToolResponse> {
    const sessionId = await this.ctx.storage.get<string>(SESSION_ID_KEY);
    if (!sessionId) throw new Error("Pi Durable session is not initialized");
    const operationId = await this.attributedOperationId(ROOT_SESSION);
    if (!operationId) throw new Error("Pi Durable has no attributed active operation");
    const response = await this.env.SESSION.getByName(sessionId).fetch(
      new Request(`http://session${SessionInternalPaths.piSandboxCommand}`, {
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
      const message =
        body &&
        typeof body === "object" &&
        !Array.isArray(body) &&
        "error" in body &&
        typeof body.error === "string"
          ? body.error
          : `Sandbox execution failed (${response.status})`;
      throw new Error(message);
    }
    return sandboxExecutionToolResponseSchema.parse(body);
  }

  private async invokeAgentControl(
    control: PiAgentControlRequest,
    callerConversationId: ConversationId,
    signal?: AbortSignal
  ): Promise<JsonValue> {
    const sessionId = await this.ctx.storage.get<string>(SESSION_ID_KEY);
    if (!sessionId) throw new Error("Pi Durable session is not initialized");
    const caller = await (
      await this.harness.pi()
    ).commit((tx) => tx.conversation(callerConversationId), BACKGROUND_CONTEXT);
    if (!caller || caller.parent || caller.owner || String(caller.id) !== ROOT_SESSION) {
      throw new Error("Pi agent messaging is restricted to the root conversation");
    }
    const operationId = await this.attributedOperationId(ROOT_SESSION);
    if (!operationId) throw new Error("Pi Durable has no attributed active operation");
    const response = await this.env.SESSION.getByName(sessionId).fetch(
      new Request(`http://session${SessionInternalPaths.piAgentControl}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Pi-Operation-ID": operationId,
          ...piTraceHeader(operationId),
        },
        body: JSON.stringify(control),
        signal,
      })
    );
    const body = (await response.json().catch(() => null)) as JsonValue;
    if (!response.ok) {
      const message =
        body && typeof body === "object" && !Array.isArray(body) && typeof body.error === "string"
          ? body.error
          : `Pi agent control failed (${response.status})`;
      throw new Error(message);
    }
    return body;
  }

  /**
   * Ask the owning session whether this turn may drive a browser.
   *
   * The session decides. The agent learns only whether it may proceed.
   */
  private async authorizeBrowser(
    request: { url?: string },
    signal?: AbortSignal
  ): Promise<{ allowed: boolean; code?: string; reason?: string }> {
    const sessionId = await this.ctx.storage.get<string>(SESSION_ID_KEY);
    if (!sessionId) return { allowed: false, reason: "The session is not initialized" };
    const operationId = await this.attributedOperationId(ROOT_SESSION);
    const response = await this.env.SESSION.getByName(sessionId).fetch(
      new Request(`http://session${SessionInternalPaths.piBrowserAuthorize}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(operationId ? { "X-Pi-Operation-ID": operationId } : {}),
          ...(operationId ? piTraceHeader(operationId) : {}),
        },
        body: JSON.stringify(request),
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
        reason: body?.reason ?? "The browser is not available for this session",
      };
    }
    return { allowed: true };
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
    const sessionId = await this.ctx.storage.get<string>(SESSION_ID_KEY);
    if (!sessionId) throw new Error("Pi Durable session is not initialized");
    const operationId = await this.attributedOperationId(ROOT_SESSION);
    if (!operationId) throw new Error("Pi Durable has no attributed active operation");
    const response = await this.env.SESSION.getByName(sessionId).fetch(
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

  private async fetchRepositoryMaterializationManifest(
    repository: number,
    commitSha: string,
    signal?: AbortSignal
  ): Promise<PiRepositoryMaterializationManifest> {
    return piRepositoryMaterializationManifestSchema.parse(
      await this.fetchRepositoryMaterializationPart(
        { operation: "manifest", repository, commitSha },
        signal
      )
    );
  }

  private async fetchRepositoryMaterialization(
    manifest: PiRepositoryMaterializationManifest,
    onRequest: () => void = () => {},
    signal?: AbortSignal
  ): Promise<PiRepositoryMaterialization> {
    const repository = manifest.repository.position;
    const commitSha = manifest.repository.commitSha;
    const files: PiRepositoryMaterialization["files"] = [];
    let offset = 0;
    let totalBytes = 0;
    while (offset < manifest.files.length) {
      onRequest();
      const batch = piRepositoryMaterializationBatchSchema.parse(
        await this.fetchRepositoryMaterializationPart(
          { operation: "files", repository, commitSha, offset },
          signal
        )
      );
      if (
        batch.offset !== offset ||
        JSON.stringify(batch.repository) !== JSON.stringify(manifest.repository)
      ) {
        throw new Error("Repository materialization batch does not match its manifest");
      }
      if (batch.files.length === 0) {
        throw new Error("Repository materialization batch made no progress");
      }
      const expected = manifest.files.slice(offset, offset + batch.files.length);
      for (const [index, file] of batch.files.entries()) {
        const metadata = expected[index];
        if (
          !metadata ||
          metadata.path !== file.path ||
          metadata.blobId !== file.blobId ||
          metadata.mode !== file.mode ||
          (metadata.sizeBytes !== null && metadata.sizeBytes !== file.sizeBytes)
        ) {
          throw new Error("Repository materialization file does not match its manifest");
        }
        totalBytes += file.sizeBytes;
        if (totalBytes > PI_REPOSITORY_MAX_BYTES) {
          throw new Error(
            `Repository exceeds the ${PI_REPOSITORY_MAX_BYTES} byte materialization limit`
          );
        }
        files.push(file);
      }
      const expectedNext = offset + batch.files.length;
      if (batch.nextOffset !== (expectedNext < manifest.files.length ? expectedNext : null)) {
        throw new Error("Repository materialization batch cursor is invalid");
      }
      offset = expectedNext;
    }
    return piRepositoryMaterializationSchema.parse({
      version: 1,
      repository: manifest.repository,
      files,
    });
  }

  private async fetchRepositoryMaterializationPart(
    body: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> {
    const sessionId = await this.ctx.storage.get<string>(SESSION_ID_KEY);
    if (!sessionId) throw new Error("Pi Durable session is not initialized");
    const response = await this.env.SESSION.getByName(sessionId).fetch(
      new Request(`http://session${SessionInternalPaths.piRepositoryMaterialization}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      })
    );
    if (!response.ok) throw new Error(`Repository materialization failed (${response.status})`);
    return response.json();
  }

  private async currentOperationId(): Promise<string | null> {
    return this.attributedOperationId(ROOT_SESSION);
  }

  private async attributedOperationId(conversationId: string): Promise<string | null> {
    const active = this.activeOperationByConversation.get(conversationId);
    if (active) return active;
    const inspection = await (await this.harness.pi()).inspect(BACKGROUND_CONTEXT);
    const candidates = inspection.submissions.filter(
      (submission) =>
        String(submission.conversationId) === conversationId &&
        submission.status === "placed" &&
        submission.requestId !== undefined
    );
    if (candidates.length === 1) return operationIdForSubmission(candidates[0]!.requestId) ?? null;
    if (candidates.length > 1) return null;
    const allCandidates = inspection.submissions.filter(
      (submission) => submission.status === "placed" && submission.requestId !== undefined
    );
    return allCandidates.length === 1
      ? (operationIdForSubmission(allCandidates[0]!.requestId) ?? null)
      : null;
  }

  private async publishDiffBundle(bundle: SessionDiffUpload, signal?: AbortSignal): Promise<void> {
    const sessionId = await this.ctx.storage.get<string>(SESSION_ID_KEY);
    if (!sessionId) throw new Error("Pi Durable session is not initialized");
    let response: Response;
    try {
      response = await this.env.SESSION.getByName(sessionId).fetch(
        new Request(`http://session${SessionInternalPaths.diffStore}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(bundle),
          signal,
        })
      );
    } catch (error) {
      const message = `Pi diff publication failed: ${
        error instanceof Error ? error.message : "network unavailable"
      }`;
      throw new Error(message, { cause: error });
    }
    if (!response.ok) {
      const message = `Pi diff publication failed (${response.status})`;
      if (!isRetryableDiffPublicationStatus(response.status)) {
        throw new PermanentRepositoryDiffPublicationError(message);
      }
      throw new Error(message);
    }
  }

  private async drainRepositoryDiffPublication(): Promise<RepositoryDiffPublicationOutcome> {
    await this.harness.pi();
    if (!this.repositoryWorkspaceInitializer)
      throw new Error("Pi repository editing is not enabled");
    const repositoryWorkspace = await this.repositoryWorkspaceInitializer();
    let outcome = await this.drainRepositoryDiffOutbox();
    if (outcome === "permanent" || outcome === "idle" || outcome === "published") return outcome;
    let state = this.repositoryDiffOutbox.state();
    if (state.pending) return "pending";
    if (state.recaptureRequired) {
      try {
        await this.repositoryDiffOutbox.stage(await repositoryWorkspace.captureDiff(null));
      } catch (error) {
        await this.repositoryDiffOutbox.recordCaptureFailure(error);
        const sessionId = await this.ctx.storage.get<string>(SESSION_ID_KEY);
        if (sessionId) {
          await this.recordDiffFailure(
            sessionId,
            error instanceof Error ? error.message : String(error)
          ).catch(() => {});
        }
        return "pending";
      }
      outcome = await this.drainRepositoryDiffOutbox();
      state = this.repositoryDiffOutbox.state();
      return state.pending || state.recaptureRequired ? "pending" : outcome;
    }
    return outcome;
  }

  private async drainRepositoryDiffOutbox(): Promise<RepositoryDiffPublicationOutcome> {
    const outcome = await this.repositoryDiffOutbox.drain((bundle, signal) =>
      this.publishDiffBundle(bundle, signal)
    );
    if (outcome === "pending" || outcome === "permanent") {
      const state = this.repositoryDiffOutbox.state();
      const sessionId = await this.ctx.storage.get<string>(SESSION_ID_KEY);
      if (sessionId && state.lastError) {
        await this.recordDiffFailure(sessionId, state.lastError.message).catch(() => {});
      }
    }
    return outcome;
  }

  private async recordDiffFailure(sessionId: string, error: string): Promise<void> {
    const boundedError = error.slice(0, SESSION_DIFF_MAX_ERROR_LENGTH);
    await this.env.SESSION.getByName(sessionId).fetch(
      new Request(`http://session${SessionInternalPaths.diffFailure}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: boundedError }),
        signal: AbortSignal.timeout(DIFF_FAILURE_REPORT_TIMEOUT_MS),
      })
    );
  }

  private async startEventRelay(
    sessionId: string,
    operationId: string,
    options: { recoverSnapshot?: boolean } = {}
  ): Promise<void> {
    if (this.projectedOperations.has(operationId)) return;
    const metadata = await this.operationMetadata(operationId);
    if (!metadata) throw new Error("Pi operation metadata is unavailable");
    this.projectedOperations.add(operationId);
    this.translationStateByOperation.set(operationId, { text: "", tools: new Map() });
    const queue = (events: readonly AgentEvent[]) => {
      const work = this.eventRouterWork
        .catch(() => {})
        .then(async () => {
          for (const source of events) {
            if (source.type === "run_start" || (source.type === "snapshot" && source.run)) {
              const inputs = source.type === "run_start" ? source.inputs : source.run!.inputs;
              const inspection = await (await this.harness.pi()).inspect(BACKGROUND_CONTEXT);
              const submission = inspection.submissions.find(
                (candidate) => candidate.id === inputs[0]
              );
              if (submission?.requestId)
                this.activeOperationByConversation.set(
                  ROOT_SESSION,
                  operationIdForSubmission(submission.requestId)!
                );
            }
            const routedOperation = this.activeOperationByConversation.get(ROOT_SESSION);
            if (!routedOperation || !this.projectedOperations.has(routedOperation)) {
              if (source.type === "run_end")
                this.activeOperationByConversation.delete(ROOT_SESSION);
              continue;
            }
            const routedMetadata = await this.operationMetadata(routedOperation);
            const state = this.translationStateByOperation.get(routedOperation);
            if (!routedMetadata || !state) continue;
            const translated = translatePiEvents([source], state, {
              sessionId,
              operationId: routedOperation,
              timestamp: Date.now() / 1_000,
            });
            const sourceIdentity = piAgentEventIdentity(source);
            const accounting =
              source.type === "usage_changed" ||
              source.type === "snapshot" ||
              source.type === "tool_execution_end" ||
              source.type === "compaction_end" ||
              translated.some((event) => event.type === "step_finish")
                ? await this.observeOperationAccounting(routedOperation)
                : undefined;
            for (const event of translated) {
              if (
                event.type === "step_start" &&
                !this.firstModelRequestObserved.has(routedOperation)
              ) {
                this.firstModelRequestObserved.add(routedOperation);
                this.log.info("pi.latency", {
                  event: "pi.latency",
                  milestone: "model_request",
                  timestamp_ms: Date.now(),
                  session_id: sessionId,
                  operation_id: routedOperation,
                  model: routedMetadata.model,
                });
              }
              this.projectionOutbox.enqueue(
                piProjectionIdentity(routedOperation, event, sourceIdentity),
                routedOperation,
                this.priceStepEvent(event, routedMetadata.model, accounting?.costUsd),
                Date.now()
              );
              if (event.type === "token" && !this.firstTokenCommitted.has(routedOperation)) {
                this.firstTokenCommitted.add(routedOperation);
                this.log.info("pi.latency", {
                  event: "pi.latency",
                  milestone: "first_token_committed",
                  timestamp_ms: Date.now(),
                  session_id: sessionId,
                  operation_id: routedOperation,
                  model: routedMetadata.model,
                });
              }
            }
            if (accounting?.changed) {
              const event = accountingProjectionEvent(
                sessionId,
                routedOperation,
                accounting.costUsd
              );
              this.projectionOutbox.enqueue(
                piProjectionIdentity(routedOperation, event),
                routedOperation,
                event,
                Date.now()
              );
              await this.recordProjectedCost(routedOperation, accounting.costUsd);
            }
            if (source.type === "run_end") this.activeOperationByConversation.delete(ROOT_SESSION);
          }
        });
      this.eventRouterWork = work;
      for (const registered of this.projectedOperations) this.eventRelayWork.set(registered, work);
      return work;
    };
    if (this.eventStream || this.eventStreamOpening) {
      return;
    }
    const opening = this.harness.session(ROOT_SESSION).events(BACKGROUND_CONTEXT);
    this.eventStreamOpening = opening;
    const stream = await opening;
    if (this.eventStreamOpening === opening) this.eventStreamOpening = undefined;
    this.eventStream = stream;
    if (options.recoverSnapshot) void queue([stream.snapshot]).catch(() => {});
    stream.start((events) => queue(events).catch(() => {}));
    void stream.closed.then(() => {
      if (this.eventStream === stream) this.eventStream = undefined;
    });
  }

  private async captureFinalProjection(operationId: string): Promise<void> {
    if (this.projectionOutbox.isFinalized(operationId)) return;
    await this.stopEventRelay(operationId);
    const sessionId = await this.ctx.storage.get<string>(SESSION_ID_KEY);
    if (!sessionId) throw new Error("Pi Durable session is not initialized");
    const metadata = await this.operationMetadata(operationId);
    if (!metadata) throw new Error("Pi operation metadata is unavailable");
    const entries = await this.operationEntries(operationId);
    const state = { text: "", tools: new Map() };
    const translated = translatePiEvents([settledOperationSnapshot(entries)], state, {
      sessionId,
      operationId,
      timestamp: Date.now() / 1_000,
    });
    const accounting = await this.observeOperationAccounting(operationId);
    for (const event of translated) {
      this.projectionOutbox.enqueue(
        piProjectionIdentity(operationId, event),
        operationId,
        this.priceStepEvent(event, metadata.model, accounting.costUsd),
        Date.now(),
        `final:${piProjectionIdentity(operationId, event)}`
      );
    }
    const accountingEvent = accountingProjectionEvent(sessionId, operationId, accounting.costUsd);
    this.projectionOutbox.enqueue(
      piProjectionIdentity(operationId, accountingEvent),
      operationId,
      accountingEvent,
      Date.now(),
      "final:accounting"
    );
    await this.recordProjectedCost(operationId, accounting.costUsd);
    this.projectionOutbox.markFinalized(operationId, accounting, Date.now());
  }

  private async checkpointAccounting(operationId: string): Promise<void> {
    if (this.projectionOutbox.isFinalized(operationId)) return;
    const accounting = await this.observeOperationAccounting(operationId);
    // accountingTotals() spans every Pi conversation. A may settle while that
    // read is in flight and B may then add usage; never attribute that snapshot
    // back to finalized A.
    if (this.projectionOutbox.isFinalized(operationId)) return;
    if (!accounting.changed) return;
    const sessionId = await this.ctx.storage.get<string>(SESSION_ID_KEY);
    if (!sessionId) throw new Error("Pi Durable session is not initialized");
    const event = accountingProjectionEvent(sessionId, operationId, accounting.costUsd);
    this.projectionOutbox.enqueue(
      piProjectionIdentity(operationId, event),
      operationId,
      event,
      Date.now()
    );
    await this.recordProjectedCost(operationId, accounting.costUsd);
  }

  private async operationEntries(operationId: string): Promise<EntryRecord[]> {
    const pi = await this.harness.pi();
    const submission = (await pi.inspect(BACKGROUND_CONTEXT)).submissions.find(
      (candidate) => candidate.requestId === operationId
    );
    if (!submission || submission.type !== "input" || submission.entry === undefined) return [];
    const conversation = await pi.conversation(submission.conversationId, BACKGROUND_CONTEXT);
    if (!conversation) throw new Error("Pi operation conversation is unavailable");
    const entries: EntryRecord[] = [];
    let cursor: Parameters<typeof conversation.entries>[2];
    for (;;) {
      const page = await conversation.entries(
        {
          minEntryId: submission.entry,
          ...(submission.status === "done" ? { maxEntryId: submission.answer } : {}),
          order: "ascending",
        },
        100,
        cursor,
        BACKGROUND_CONTEXT
      );
      entries.push(...page.items);
      if (page.next === undefined) return entries;
      cursor = page.next;
    }
  }

  private priceStepEvent(
    event: ReturnType<typeof translatePiEvents>[number],
    model: string,
    messageCostUsd: number | undefined
  ): ReturnType<typeof translatePiEvents>[number] {
    if (event.type !== "step_finish" || !event.tokens) return event;
    const tokens = normalizeTokenUsage(event.tokens);
    const usage: PiRuntimeUsage = {
      input: tokens.inputTokens ?? 0,
      output: tokens.outputTokens ?? 0,
      reasoning: tokens.reasoningTokens ?? undefined,
      cacheRead: tokens.cacheReadTokens ?? 0,
      cacheWrite: tokens.cacheWriteTokens ?? 0,
      total: tokens.totalTokens ?? 0,
    };
    const cost = calculatePiUsageCost(this.models, model, usage);
    return { ...event, cost, ...(messageCostUsd === undefined ? {} : { messageCostUsd }) };
  }

  private async stopEventRelay(operationId: string): Promise<void> {
    try {
      await this.eventRelayWork.get(operationId);
    } catch {
      // Terminal projection below is the durable backstop for a failed live relay.
    } finally {
      this.eventRelayWork.delete(operationId);
      this.projectedOperations.delete(operationId);
      this.translationStateByOperation.delete(operationId);
    }
  }

  private async deliverEventProjection(
    sequence: number,
    displayId: string,
    operationId: string,
    event: ReturnType<typeof translatePiEvents>[number]
  ): Promise<void> {
    const sessionId = await this.ctx.storage.get<string>(SESSION_ID_KEY);
    if (!sessionId) throw new Error("Pi Durable session is not initialized");
    const response = await this.env.SESSION.getByName(sessionId).fetch(
      new Request(`http://session${SessionInternalPaths.piEvent}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Pi-Operation-ID": operationId,
          ...piTraceHeader(operationId),
          "X-Pi-Projection-ID": displayId,
          "X-Pi-Projection-Sequence": String(sequence),
        },
        body: JSON.stringify(event),
      })
    );
    if (response.status >= 500)
      throw new Error(`Pi event delivery unavailable (${response.status})`);
    if (!response.ok) {
      throw new PermanentPiProjectionError(`Pi event delivery rejected (${response.status})`);
    }
    if (event.type === "token" && !this.firstTokenProjected.has(operationId)) {
      this.firstTokenProjected.add(operationId);
      this.log.info("pi.latency", {
        event: "pi.latency",
        milestone: "first_token_projected",
        timestamp_ms: Date.now(),
        session_id: sessionId,
        operation_id: operationId,
        projection_sequence: sequence,
      });
    }
  }

  private async deliverResult(sessionId: string, result: PiRuntimeResult): Promise<void> {
    let response: Response;
    try {
      response = await this.env.SESSION.getByName(sessionId).fetch(
        new Request(`http://session${SessionInternalPaths.piResult}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(result),
        })
      );
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "overloaded" in error &&
        error.overloaded === true
      ) {
        throw error;
      }
      throw new RetryablePiProjectionError("Pi result delivery unavailable", { cause: error });
    }
    if (response.status >= 500) {
      throw new RetryablePiProjectionError(`Pi result delivery failed (${response.status})`);
    }
    if (!response.ok) {
      throw new PermanentPiResultDeliveryError(`Pi result delivery rejected (${response.status})`);
    }
    this.log.info("pi.latency", {
      event: "pi.latency",
      milestone: "terminal",
      timestamp_ms: Date.now(),
      session_id: sessionId,
      operation_id: result.operationId,
      outcome: result.status,
    });
  }
}

function isRetryableDiffPublicationStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function sanitizeInspection(
  inspection: Awaited<ReturnType<Awaited<ReturnType<PiSessionDO["harness"]["pi"]>>["inspect"]>>
): JsonValue {
  return {
    scheduling: inspection.scheduling,
    tasks: inspection.tasks.slice(0, 64).map(({ record, state }) => ({
      id: record.id,
      kind: record.kind,
      conversationId: record.conversationId,
      state: {
        kind: state.kind,
        ...("phase" in record.state ? { phase: record.state.phase } : {}),
      },
    })),
    submissions: inspection.submissions.slice(-200).map((submission) => ({
      id: submission.id,
      conversationId: submission.conversationId,
      requestId: operationIdForSubmission(submission.requestId),
      type: submission.type,
      status: submission.status,
      ...("entry" in submission && submission.entry !== undefined
        ? { entry: submission.entry }
        : {}),
      ...("answer" in submission && submission.answer !== undefined
        ? { answer: submission.answer }
        : {}),
    })),
  } as unknown as JsonValue;
}

function lastAgentMessage(
  page: { readonly items: readonly EntryRecord[] },
  maxLength: number
): JsonValue {
  const entries = [...page.items].sort((left, right) => Number(right.id) - Number(left.id));
  for (const entry of entries) {
    for (const message of [...(entry.model ?? [])].reverse()) {
      if (message.role !== "assistant") continue;
      const text = message.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("")
        .slice(0, maxLength);
      if (text) return { entryId: entry.id, text };
    }
  }
  return null;
}

function latestAssistantEntryId(entries: readonly EntryRecord[]): number | null {
  let latest: number | null = null;
  for (const entry of entries) {
    const hasAssistantText = entry.model?.some(
      (message) =>
        message.role === "assistant" &&
        message.content.some((part) => part.type === "text" && part.text.length > 0)
    );
    if (!hasAssistantText) continue;
    const id = Number(entry.id);
    if (latest === null || id > latest) latest = id;
  }
  return latest;
}

function nativeControlSubmissionRequestId(requestId: string): string {
  return `${CONTROL_SUBMISSION_REQUEST_PREFIX}${requestId}`;
}

function operationIdForSubmission(requestId: string | undefined): string | undefined {
  if (!requestId) return undefined;
  return requestId.startsWith(CONTROL_SUBMISSION_REQUEST_PREFIX)
    ? requestId.slice(CONTROL_SUBMISSION_REQUEST_PREFIX.length)
    : requestId;
}

async function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw signal.reason ?? new Error("Operation aborted");
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(signal.reason ?? new Error("Operation aborted")),
        {
          once: true,
        }
      );
    }),
  ]);
}

function declaredEffects(extension: {
  readonly tools?: readonly { readonly name: string }[];
}): ToolEffectRegistration[] {
  return (extension.tools ?? []).map(({ name }) => {
    const declaration = PI_TOOL_EFFECT_REGISTRY.get(name);
    if (!declaration) throw new Error(`Pi tool has no effect declaration: ${name}`);
    return declaration;
  });
}

function accountingProjectionEvent(
  sessionId: string,
  operationId: string,
  messageCostUsd: number
): Extract<SandboxIngressEvent, { type: "step_finish" }> {
  return {
    type: "step_finish",
    sandboxId: `pi:${sessionId}`,
    timestamp: Date.now() / 1_000,
    messageId: operationId,
    stepId: `${operationId}:accounting`,
    cost: null,
    messageCostUsd,
  };
}

function settledOperationSnapshot(entries: readonly EntryRecord[]): AgentEvent {
  return {
    type: "snapshot",
    entries,
    tools: [],
    nestedTools: [],
    compactions: [],
    inbox: [],
    agent: {},
    usage: { models: {}, tools: {} },
  };
}

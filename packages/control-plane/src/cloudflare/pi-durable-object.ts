import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Workspace, type DurableObjectStorageLike } from "@cloudflare/computer";
import {
  PI_BROWSER_TOOL_EFFECT_REGISTRATIONS,
  PI_CODEMODE_TOOL_EFFECT_REGISTRATIONS,
  PI_MCP_TOOL_EFFECT_REGISTRATIONS,
  PI_MEMORY_READ_TOOL_EFFECT_REGISTRATIONS,
  PI_MEMORY_TOOL_EFFECT_REGISTRATIONS,
  PI_TOOL_EFFECT_REGISTRY,
  normalizeTokenUsage,
  createPiFeatureCapabilitySnapshot,
  piFeatureCapabilitySnapshotSchema,
  type PiFeatureCapabilityInput,
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
  type Extension,
  type ConversationId,
  type EntryId,
  type TaskId,
  type SubmissionId,
  type UserInput,
} from "@earendil-works/pi-durable";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ResolvedSessionAttachment } from "@open-inspect/shared/types/session-attachments";
import { DurableObject } from "cloudflare:workers";
import { createBrowserExtension, type BrowserReadAnswer } from "../pi/browser-extension";
import type { PiBrowserAction, PiBrowserOutcome } from "../pi/browser-transport";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { SessionInternalPaths, type SessionInternalPath } from "../session/contracts";
import { CodexBrokerCredentialStore } from "../pi/codex-credential-store";
import { PiProjectionCapability } from "../pi/projection-capability";
import { applyPiDoMigrations } from "../pi/schema";
import {
  PermanentPiResultDeliveryError,
  RetryablePiProjectionError,
} from "../pi/projection-retry-policy";
import { translatePiEvents, type PiEventTranslationState } from "../pi/event-translator";
import { piBlockedReason, sanitizePiInspection } from "../pi/inspection-sanitizer";
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
import { scopeBindings, scopedBindingNames } from "./binding-scope";
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
import { assembleExtensions, type ExtensionContribution } from "../harness/extension-assembler";
import { createToolPolicyExtension } from "../pi/tool-policy-extension";
import type { PiToolPolicyDelegate } from "../pi/tool-policy-types";
import {
  PI_FEATURE_CAPABILITY_SNAPSHOT_KEY,
  PI_LEGACY_FEATURE_CAPABILITY_SNAPSHOT,
  readPiFeatureCapabilitySnapshot,
} from "../pi/capability-snapshot";
import { PiRepositoryWorkspace } from "../pi/repository-workspace";
import { z } from "zod";
import {
  memorySearchResponseSchema,
  sandboxMemoryReadResultSchema,
  sandboxMemoryWriteResultSchema,
  type MemorySearchInput,
  type MemorySearchResponse,
  type SandboxMemoryReadResult,
  type SandboxMemoryWriteInput,
  type SandboxMemoryWriteResult,
} from "@open-inspect/shared/types/memories";
import { createBrowserPolicyDelegate } from "../pi/browser-policy-extension";
import { createMemoryExtension } from "../pi/memory-extension";
import {
  createMemoryPolicyDelegate,
  MEMORY_OWNED_TOOL_NAMES,
  type MemoryWriteAuthorizationDecision,
} from "../pi/memory-policy-extension";
import {
  createSandboxExecutionExtension,
  createSandboxExecutionPolicyDelegate,
  type SandboxExecutionToolRequest,
  type SandboxExecutionToolResponse,
} from "../pi/sandbox-execution-extension";
import { createMcpExtension } from "../pi/mcp-extension";
import {
  mcpReadResultSchema,
  mcpSharedServerListSchema,
  type McpReadResult,
} from "@open-inspect/shared/types/mcp-read";
import { PI_SANDBOX_EXECUTION_TOOL_EFFECT_REGISTRATIONS } from "@open-inspect/shared";
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
import { createDeploymentEmergencyPolicy } from "../harness/emergency-policy";
import { piEmergencyRequirement } from "../pi/emergency-policy-vocabulary";
import { fetchExecutionPrincipal } from "../harness/execution-principal";
import { PermanentPiProjectionError, PiProjectionOutbox } from "../pi/projection-outbox";
import { piAgentEventIdentity, piProjectionIdentity } from "../pi/projection-identity";
import { hasTrustedPrice } from "../harness/pricing";
import {
  createFixedActionCeiling,
  HARNESS_ACTION_CEILING,
  type HarnessActionCeiling,
} from "../harness/action-ceiling";
import { createPiPriceTable } from "../pi/price-table";
import {
  createFixedActionCeiling,
  HARNESS_ACTION_CEILING,
  type HarnessActionCeiling,
} from "../harness/action-ceiling";
import { createBudgetGateProvider, type HarnessBudgetState } from "../harness/budget-gate";
import { armTurnDeadline, type HarnessTurnDeadline } from "../harness/turn-deadline";
import {
  accountingDelta,
  summarizeUsage,
  type HarnessUsageState,
  type UsageAccountingSnapshot,
} from "../harness/accounting";
import {
  PermanentRepositoryDiffPublicationError,
  RepositoryDiffOutbox,
  type RepositoryDiffPublicationOutcome,
} from "../pi/repository-diff-outbox";
import { RepositoryDiffPublicationCapability } from "../pi/repository-diff-publication";
import { OpenInspectPiTelemetryContext } from "../pi/pi-telemetry";
import { PiHarnessWakeController } from "../pi/pi-harness-wake";
import { piTraceHeader, piTraceId } from "../pi/pi-trace";
import { modelAcceptsImages } from "../pi/model-image-support";
import { createLogger } from "../logger";

/**
 * The Pi Durable Object's bindings.
 *
 * There is no browser binding here on purpose: the browser belongs to the
 * owning session, whose gateway authorizes every request and drives the
 * browser itself. The agent proposes; the session acts.
 */
type PiWorkerBindings = Pick<WorkerBindings, "SESSION" | "CODEMODE_SANDBOX">;

/**
 * The bindings this object is allowed to hold.
 *
 * The object is handed the whole Worker env at runtime — every secret, the
 * global database, every service binding — whatever its TypeScript type
 * says. The type is a promise to the compiler; the object is what the code
 * inside it can reach, and this object runs model-driven code.
 *
 * So the env is scoped *before* it reaches the base class. `this.env` then
 * holds an object that physically has no secret in it: the containment is
 * structural, not a promise about a type.
 */
const PI_DO_BINDING_KEYS = ["SESSION", "CODEMODE_SANDBOX"] as const;

/** What the owning session answers to one browser request. */
type BrowserReadBody = { allowed?: boolean; reason?: string; outcome?: PiBrowserOutcome };

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

/**
 * Base64-encode bytes for a model request.
 *
 * `btoa` takes a string, and one argument list this long would overflow the
 * call stack, so the bytes are encoded in chunks.
 */
function encodeBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

interface PiOperationMetadata {
  readonly model: string;
  readonly baseline: UsageAccountingSnapshot;
  readonly projectedCostUsd: number;
  readonly settledAt?: number;
}
interface NativeControlCompletion {
  readonly sessionId: string;
  readonly requestId: string;
  readonly baseline: UsageAccountingSnapshot;
  readonly suppressCost: boolean;
  /**
   * The turn a queued follow-up was submitted behind.
   *
   * The follow-up starts its own run when that turn answers, so the running
   * turn's final accounting is where the follow-up's own spend begins.
   */
  readonly runningOperationId?: string;
  readonly target:
    | { readonly kind: "submission"; readonly id: number }
    | { readonly kind: "task"; readonly id: number };
}
/** OpenCode-free, sandbox-free Pi runtime for one Open-Inspect session. */
export class PiSessionDO extends DurableObject<PiWorkerBindings> {
  constructor(ctx: DurableObjectState, env: PiWorkerBindings) {
    super(ctx, scopeBindings(env, PI_DO_BINDING_KEYS));
    // The object's own tables are created by its tracked migrations, once per
    // activation, before any writer can reach them. A writer that finds its
    // table missing is a deployment that did not migrate, not something to
    // paper over at first use.
    applyPiDoMigrations(this.ctx.storage.sql);
  }

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
  /** The deadline of every turn this object is running. */
  private readonly turnDeadlines = new Map<string, HarnessTurnDeadline>();
  /** The ceiling on what this turn may do; a fresh one for every turn. */
  private turnActionCeiling: HarnessActionCeiling =
    createFixedActionCeiling(HARNESS_ACTION_CEILING);
  private readonly prices = createPiPriceTable(this.models);
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
        (await this.fetchCapabilityAuthorityForStoredSession(signal)).current;
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
          // The session owns the run: the turn, its actor, and the latched
          // capability. The run appears on the session's timeline.
          await this.authorizeCodeMode(signal);
        },
      });
      const codeModePolicyDelegate = createPiCodeModePolicyDelegate(codeModePolicy);
      const sandboxExecutionPolicyDelegate = createSandboxExecutionPolicyDelegate();
      const emergencyPolicy = createDeploymentEmergencyPolicy({
        currentCapabilities,
        requirementFor: piEmergencyRequirement,
      });
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
      const extensions: ExtensionContribution<Extension>[] = [
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
            const memoryDelegate = createMemoryPolicyDelegate({
              client: {
                authorize: async (request, signal) => this.authorizeMemoryWrite(request, signal),
              },
            });
            return createToolPolicyExtension({
              effects,
              // The ceiling is per turn; the policy is installed once.
              ceiling: () => this.turnActionCeiling,
              delegates: workspacePolicyDelegate
                ? [
                    browserDelegate,
                    memoryDelegate,
                    workspacePolicyDelegate,
                    codeModePolicyDelegate,
                    sandboxExecutionPolicyDelegate,
                  ]
                : [
                    browserDelegate,
                    memoryDelegate,
                    codeModePolicyDelegate,
                    sandboxExecutionPolicyDelegate,
                  ],
              emergencyPolicy,
            });
          },
        },
        { slot: "core", extension: core, effects: declaredEffects(core) },
        {
          slot: "delegation",
          extension: delegation,
          effects: declaredEffects(delegation),
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
      if (capabilities.mcp !== "off") {
        extensions.push({
          slot: "mcp",
          feature: "mcp",
          minimumCapability: "read_only",
          extension: createMcpExtension({
            client: {
              read: (request, signal) => this.readMcpTool(request, signal),
              list: (signal) => this.listMcpSharedServers(signal),
            },
          }),
          effects: PI_MCP_TOOL_EFFECT_REGISTRATIONS,
        });
      }
      if (capabilities.browser !== "off") {
        extensions.push({
          slot: "browser",
          feature: "browser",
          minimumCapability: "enabled",
          extension: createBrowserExtension({
            read: (request, signal) => this.readBrowser(request, signal),
          }),
          effects: PI_BROWSER_TOOL_EFFECT_REGISTRATIONS,
          ownedToolNames: PI_BROWSER_TOOL_EFFECT_REGISTRATIONS.map((effect) => effect.name),
        });
      }
      if (capabilities.memory !== "off") {
        // A read-only capability admits the reads alone; the write is a
        // change to the tenant's memory and needs the full capability.
        const memoryEffects =
          capabilities.memory === "enabled"
            ? PI_MEMORY_TOOL_EFFECT_REGISTRATIONS
            : PI_MEMORY_READ_TOOL_EFFECT_REGISTRATIONS;
        extensions.push({
          slot: "memory",
          feature: "memory",
          minimumCapability: "read_only",
          extension: createMemoryExtension({
            client: {
              read: (request, signal) => this.readMemory(request, signal),
              write: (request, signal) => this.writeMemory(request, signal),
              search: (request, signal) => this.searchMemory(request, signal),
            },
            memory: sessionContext.memory,
            mode: capabilities.memory,
          }),
          effects: memoryEffects,
          ownedToolNames: MEMORY_OWNED_TOOL_NAMES.filter((name) =>
            memoryEffects.some((registration) => registration.name === name)
          ),
        });
      }
      const assembly = assembleExtensions(extensions, capabilities);
      for (const extension of assembly.extensions) this.registry.install(extension);
      // The provider is wrapped so the budget is checked before *every*
      // model call, not only after a step is priced.
      this.models.setProvider(
        createBudgetGateProvider(openaiCodexProvider(), () => this.readBudgetState())
      );
      const openStartedAt = Date.now();
      const opened = await Harness.open(
        storage,
        {
          models: this.models,
          registry: this.registry,
          // The Durable Object stays resident between turns, so nothing is
          // kept in memory after a conversation goes idle: no rendered
          // context, no loaded documents. A later turn reads them again from
          // storage, under the authority it has then.
          settings: {
            contextRetentionMs: 0,
            documentRetentionMs: 0,
          },
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
      this.turnDeadlines.get(result.operationId)?.clear();
      this.turnDeadlines.delete(result.operationId);
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
      this.turnDeadlines.get(operationId)?.clear();
      this.turnDeadlines.delete(operationId);
      this.projectionOutbox.complete(operationId);
      await this.settleOperationMetadata(operationId);
    },
    fail: async (sessionId, operationId, error) => {
      this.turnDeadlines.get(operationId)?.clear();
      this.turnDeadlines.delete(operationId);
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

  /**
   * The names of the bindings this object holds.
   *
   * A diagnostic, and the way the containment is proved. The names only, no
   * values, so a test can assert that the deployment's secrets are not among
   * them: remove the scoping in the constructor and the whole Worker env is
   * here, and the assertion fails.
   */
  runtimeBindingNames(): string[] {
    return scopedBindingNames(this.env);
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
      ...pending.map(async (operation) => {
        // A native control submission was never admitted as a message of
        // this session, so it has no operation metadata. Its completion is
        // recorded by the control path. Relaying it would fail the whole
        // startup and strand every later prompt.
        if (!(await this.operationMetadata(operation.operationId))) return;
        return this.startEventRelay(sessionId, operation.operationId, {
          recoverSnapshot: operation.status === "running",
        });
      }),
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
    let userInput: UserInput;
    try {
      await this.ensureSession(input.sessionId);
      await this.configure(input);
      await this.ensureSession(input.sessionId);
      // The turn's images are fetched before anything is recorded or
      // scheduled: a turn that cannot carry its image is refused outright,
      // never admitted and quietly run without one.
      // A fresh ceiling for this turn.
      this.turnActionCeiling = createFixedActionCeiling(HARNESS_ACTION_CEILING);
      const hydrated = await this.buildUserInput(input);
      if (!hydrated.ok) {
        await this.stopEventRelay(input.messageId).catch(() => {});
        return {
          operationId: input.messageId,
          accepted: false,
          rejected: hydrated.reason,
        };
      }
      userInput = hydrated.userInput;
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
    const receipt = await this.harness.submit(userInput, {
      session: ROOT_SESSION,
      operationId: input.messageId,
    });
    // The turn's deadline is armed inside the object. A turn that never
    // finishes would otherwise hold the object, its storage, and the
    // session's money for as long as it liked.
    this.armTurnDeadline(input.messageId, input.executionDeadlineMs);
    // The turn's deadline is armed inside the object. A turn that never
    // finishes would otherwise hold the object, its storage, and the
    // session's money for as long as it liked.
    this.armTurnDeadline(input.messageId, input.executionDeadlineMs);
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

  /**
   * The session's budget, read now.
   *
   * The budget gate asks for this before every model call, so the limit is
   * checked before the money is spent, not after.
   */
  private async readBudgetState(): Promise<HarnessBudgetState> {
    const sessionId = await this.ctx.storage.get<string>(SESSION_ID_KEY);
    if (!sessionId) return { exhausted: false, spentUsd: 0, capUsd: null };
    try {
      const response = await this.env.SESSION.getByName(sessionId).fetch(
        new Request(`http://session${SessionInternalPaths.budgetState}`)
      );
      if (!response.ok) return { exhausted: false, spentUsd: 0, capUsd: null };
      const state = (await response.json()) as HarnessBudgetState;
      return {
        exhausted: state.exhausted === true,
        spentUsd: typeof state.spentUsd === "number" ? state.spentUsd : 0,
        capUsd: typeof state.capUsd === "number" ? state.capUsd : null,
      };
    } catch {
      // A budget that cannot be read is not a budget that is reached.
      return { exhausted: false, spentUsd: 0, capUsd: null };
    }
  }

  /**
   * Arm the turn's deadline, and stop the turn when it passes.
   *
   * The stop is the harness's own abort, so the turn ends the way a cancelled
   * turn ends: with a recorded outcome, not a vanished object.
   */
  private armTurnDeadline(operationId: string, deadlineMs: number | undefined): void {
    if (deadlineMs === undefined) return;
    this.turnDeadlines.get(operationId)?.clear();
    const deadline = armTurnDeadline({
      deadlineMs,
      onExpire: async () => {
        this.log.warn("pi.turn.deadline", {
          event: "pi.turn.deadline",
          operation_id: operationId,
          deadline_ms: deadlineMs,
        });
        await this.harness.abort({ session: ROOT_SESSION, operationId }).catch(() => false);
      },
    });
    this.turnDeadlines.set(operationId, deadline);
  }

  /**
   * The turn's user input, with the images the turn claimed.
   *
   * The bytes stay in the session's media bucket: the session that owns the
   * turn serves them over the binding, the way it serves a sandbox harness
   * its images. They are base64-encoded here because that is what a model
   * request carries. A turn whose image cannot be loaded is refused with a
   * bounded reason the user can act on.
   */
  private async buildUserInput(
    input: PiRuntimePrompt
  ): Promise<{ ok: true; userInput: UserInput } | { ok: false; reason: string }> {
    const attachments = input.attachments ?? [];
    if (attachments.length === 0) return { ok: true, userInput: input.content };
    if (!this.modelTakesImages(input.model)) {
      return { ok: false, reason: "The selected model does not accept image attachments" };
    }
    const parts: Array<TextContent | ImageContent> = [];
    if (input.content.trim().length > 0) {
      parts.push({ type: "text", text: input.content });
    }
    for (const attachment of attachments) {
      const image = await this.fetchAttachmentImage(input, attachment);
      if (!image) {
        return { ok: false, reason: "An attached image could not be loaded" };
      }
      parts.push(image);
    }
    return { ok: true, userInput: parts };
  }

  /**
   * Whether the model this turn runs takes images.
   *
   * The registry the Pi Durable Object opened is the authority here: it is
   * the catalog the turn's model is actually served from.
   */
  private modelTakesImages(modelId: string): boolean {
    let reference: { provider: "openai-codex"; id: string };
    try {
      reference = toPiModel(modelId);
    } catch {
      return false;
    }
    return modelAcceptsImages(this.models.getModel(reference.provider, reference.id));
  }

  private async fetchAttachmentImage(
    input: PiRuntimePrompt,
    attachment: ResolvedSessionAttachment
  ): Promise<ImageContent | null> {
    const response = await this.env.SESSION.getByName(input.sessionId).fetch(
      new Request(`http://session${SessionInternalPaths.piAttachment}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Pi-Operation-ID": input.messageId,
        },
        body: JSON.stringify({ attachmentId: attachment.attachmentId }),
      })
    );
    if (!response.ok) {
      this.log.warn("pi.attachment_unavailable", {
        event: "pi.attachment_unavailable",
        session_id: input.sessionId,
        operation_id: input.messageId,
        attachment_id: attachment.attachmentId,
        status: response.status,
      });
      return null;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) return null;
    const mimeType = response.headers.get("Content-Type") ?? attachment.mimeType;
    return { type: "image", data: encodeBase64(bytes), mimeType };
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
        result: sanitizePiInspection(inspection, operationIdForSubmission),
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
    if (!(input.action === "submit" || input.action === "send" || input.action === "follow_up"))
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
      if (
        input.action === "follow_up" &&
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
      const whenBusy = input.action === "follow_up" ? "followUp" : "reject";
      const baseline = await this.accountingTotals();
      const submission = await conversation.submit(
        {
          type: "input",
          content: input.content,
          requestId: nativeControlSubmissionRequestId(input.operationId ?? input.requestId),
          whenBusy,
        },
        BACKGROUND_CONTEXT
      );
      await this.scheduleNativeControlCompletion({
        sessionId: input.sessionId,
        requestId: input.requestId,
        baseline,
        // A follow-up starts its own run, so its spend is charged here; when
        // it was queued behind a running turn, the running turn's final
        // accounting is the baseline, so that turn is not counted twice.
        suppressCost: false,
        ...(input.action === "follow_up" && conversationBusy
          ? { runningOperationId: (await this.attributedOperationId(ROOT_SESSION)) ?? undefined }
          : {}),
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
    const costBaseline = record.runningOperationId
      ? ((await this.finalRunningCost(record.runningOperationId)) ?? record.baseline.costUsd)
      : record.baseline.costUsd;
    const accounting = record.suppressCost
      ? { costUsd: 0 }
      : {
          ...accountingDelta(current, {
            usage: record.baseline.usage,
            costUsd: record.baseline.costUsd,
          }),
          // The follow-up's own spend, measured from the turn it was queued
          // behind. The running turn is charged to its own message.
          costUsd: Math.max(0, current.costUsd - costBaseline),
        };
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

  /**
   * The cumulative cost a running turn ended at.
   *
   * A follow-up queued behind a running turn starts its own run when that
   * turn answers, so the follow-up's own spend begins where the running turn
   * ended. The running turn's baseline and its own projected cost add up to
   * that point.
   */
  private async finalRunningCost(operationId: string): Promise<number | undefined> {
    const metadata = await this.operationMetadata(operationId);
    if (!metadata) return undefined;
    return metadata.baseline.costUsd + metadata.projectedCostUsd;
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
              // A blocked agent says why it cannot run.
              ...(task.state.kind === "blocked" ? { blocked: piBlockedReason(task.state) } : {}),
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
          const usage = summarizeUsage(view.value.docs["pi.usage"] as unknown as HarnessUsageState);
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

  /**
   * Preserve this object's durable record for an archive.
   *
   * The archive is the promise that the record survives and that the agent is
   * done. For the sandbox that promise is kept by saving the runtime and
   * stopping it. For Pi it is kept by stopping the agent's work and by
   * delivering every event the agent produced: the owning session's timeline
   * — and the export read from it — then hold the whole record rather than a
   * prefix of it.
   *
   * Nothing durable is deleted. The native transcript, the task graph, the
   * compaction boundaries and the workspace files stay where they are.
   */
  async preserveForArchive(sessionId: string): Promise<void> {
    await this.ensureSession(sessionId);
    // The agent stops working on an archived session: the archive says the
    // record is finished, not that the run may continue. A cold object has
    // no live code to abort, and opening its harness here would make the
    // archive depend on repository rematerialization and on a provider that
    // may be unavailable or revoked.
    if (this.harnessOpened) await this.harness.abort({ session: ROOT_SESSION }).catch(() => false);
    // Every event the agent produced reaches the owning session. A delivery
    // that fails stays in the outbox, where the projector's job retries it,
    // so the archive is never blocked by a provider that is down.
    for (const operationId of this.projectionOutbox.undeliveredOperations()) {
      await this.projectionOutbox.drain(operationId).catch((error) => {
        this.log.warn("pi.archive_projection_incomplete", {
          event: "pi.archive_projection_incomplete",
          operation_id: operationId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
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
    if (!hasTrustedPrice(this.prices, modelId)) {
      throw new Error(`Pi model ${modelId} has no trusted server pricing`);
    }
  }

  private async rememberOperation(
    input: Pick<PiRuntimePrompt, "messageId" | "model">,
    baseline: UsageAccountingSnapshot
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

  private async accountingTotals(): Promise<UsageAccountingSnapshot> {
    return summarizeUsage(await (await this.harness.pi()).usage(BACKGROUND_CONTEXT));
  }

  private async observeOperationAccounting(
    operationId: string
  ): Promise<UsageAccountingSnapshot & { changed: boolean }> {
    const current = await this.accountingTotals();
    const key = `${OPERATION_METADATA_PREFIX}${operationId}`;
    const metadata = await this.ctx.storage.get<PiOperationMetadata>(key);
    if (!metadata) throw new Error("Pi operation accounting metadata is unavailable");
    const delta = accountingDelta(current, {
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
    // The principal answers with the capability *map*; the versioned
    // snapshot is written here, where the version belongs.
    const authoritativeSnapshot = authority.snapshot
      ? createPiFeatureCapabilitySnapshot(authority.snapshot as PiFeatureCapabilityInput)
      : PI_LEGACY_FEATURE_CAPABILITY_SNAPSHOT;
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
    return fetchExecutionPrincipal(this.env.SESSION.getByName(sessionId), {
      path: SessionInternalPaths.piCapabilityAuthority,
      signal,
    });
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

  private async readMemory(
    request: { memoryId: string },
    signal?: AbortSignal
  ): Promise<SandboxMemoryReadResult> {
    return this.memoryRequest(
      SessionInternalPaths.piMemoryRead,
      request,
      signal,
      sandboxMemoryReadResultSchema
    );
  }

  /** Write one memory through the owning session. */
  private async writeMemory(
    request: SandboxMemoryWriteInput,
    signal?: AbortSignal
  ): Promise<SandboxMemoryWriteResult> {
    return this.memoryRequest(
      SessionInternalPaths.piMemoryWrite,
      request,
      signal,
      sandboxMemoryWriteResultSchema
    );
  }

  /** Search the session's facts through the owning session. */
  private async searchMemory(
    request: MemorySearchInput,
    signal?: AbortSignal
  ): Promise<MemorySearchResponse> {
    return this.memoryRequest(
      SessionInternalPaths.piMemorySearch,
      request,
      signal,
      memorySearchResponseSchema
    );
  }

  /**
   * Ask the owning session whether this write is permitted.
   *
   * The session owns the decision: it resolves the target partition and the
   * session principal's current access to it, exactly as the write does.
   */
  private async authorizeMemoryWrite(
    request: SandboxMemoryWriteInput,
    signal?: AbortSignal
  ): Promise<MemoryWriteAuthorizationDecision> {
    return this.memoryRequest(
      SessionInternalPaths.piMemoryAuthorize,
      request,
      signal,
      z.object({ allowed: z.boolean(), reason: z.string().optional() })
    );
  }

  /**
   * One memory call to the owning session.
   *
   * The session is addressed by its own Durable Object binding, so the
   * request can only reach the session this runtime was initialized for. The
   * turn id rides along so the session can fence the call to a live turn and
   * record the effect against it.
   */
  private async memoryRequest<Result>(
    path: SessionInternalPath,
    body: unknown,
    signal: AbortSignal | undefined,
    resultSchema: z.ZodType<Result>
  ): Promise<Result> {
    const sessionId = await this.ctx.storage.get<string>(SESSION_ID_KEY);
    if (!sessionId) throw new Error("Pi Durable session is not initialized");
    const operationId = await this.attributedOperationId(ROOT_SESSION);
    if (!operationId) throw new Error("Pi Durable has no attributed active operation");
    const response = await this.env.SESSION.getByName(sessionId).fetch(
      new Request(`http://session${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Pi-Operation-ID": operationId,
          "x-request-id": operationId,
          ...piTraceHeader(operationId),
        },
        body: JSON.stringify(body),
        signal,
      })
    );
    const parsed = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(
        typeof (parsed as { error?: unknown } | null)?.error === "string"
          ? (parsed as { error: string }).error
          : "The memory operation did not complete"
      );
    }
    return resultSchema.parse(parsed);
  }

  /**
   * Read one reviewed MCP tool through the owning session.
   *
   * The session resolves the server's repository scope and the reviewed
   * catalog. The agent never holds a credential and never names one.
   */
  private async readMcpTool(
    request: {
      serverId: string;
      toolName: string;
      arguments: Record<string, unknown>;
    },
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

  /** The shared MCP servers this session may read. */
  private async listMcpSharedServers(signal?: AbortSignal): Promise<{
    shared: Array<{ serverId: string; serverName: string; toolNames: string[] }>;
  }> {
    const sessionId = await this.ctx.storage.get<string>(SESSION_ID_KEY);
    if (!sessionId) throw new Error("Pi Durable session is not initialized");
    const operationId = await this.currentOperationId();
    if (!operationId) throw new Error("Pi Durable has no attributed active operation");
    const response = await this.env.SESSION.getByName(sessionId).fetch(
      new Request(`http://session${SessionInternalPaths.piMcpList}`, {
        method: "GET",
        headers: { "X-Pi-Operation-ID": operationId },
        ...(signal ? { signal } : {}),
      })
    );
    const body = await response.json().catch(() => null);
    if (!response.ok) return { shared: [] };
    const parsed = mcpSharedServerListSchema.safeParse(body);
    return parsed.success
      ? {
          shared: parsed.data.shared.map((server) => ({
            serverId: server.serverId,
            serverName: server.serverName,
            toolNames: server.toolNames,
          })),
        }
      : { shared: [] };
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
  /**
   * Ask the owning session whether this browser request may happen.
   *
   * The session decides. The agent learns only whether it may proceed.
   */
  /**
   * Ask the owning session to authorize one Code Mode run.
   *
   * The session decides: the turn must belong to it, the turn must have a
   * workspace actor, and the session's latched capability must allow Code
   * Mode. The run is then recorded on the session's timeline.
   */
  private async authorizeCodeMode(signal?: AbortSignal): Promise<void> {
    const sessionId = await this.ctx.storage.get<string>(SESSION_ID_KEY);
    if (!sessionId) throw new Error("Pi Durable session is not initialized");
    const operationId = await this.attributedOperationId(ROOT_SESSION);
    if (!operationId) throw new Error("Pi Durable has no attributed active operation");
    const response = await this.env.SESSION.getByName(sessionId).fetch(
      new Request(`http://session${SessionInternalPaths.piCodeModeAuthorize}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Pi-Operation-ID": operationId,
          ...piTraceHeader(operationId),
        },
        body: JSON.stringify({}),
        signal,
      })
    );
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? "Code Mode is not available for this session");
    }
  }

  /**
   * Ask the owning session to read one page.
   *
   * The session authorizes the request, records it on the session's timeline,
   * and drives the browser itself. The agent proposes; the session decides
   * and acts, and the agent receives the bounded page and nothing else.
   */
  private async readBrowser(
    request: { action: PiBrowserAction; url: string },
    signal?: AbortSignal
  ): Promise<BrowserReadAnswer> {
    const sessionId = await this.ctx.storage.get<string>(SESSION_ID_KEY);
    if (!sessionId) return { allowed: false, reason: "The session is not initialized" };
    const operationId = await this.attributedOperationId(ROOT_SESSION);
    let body: BrowserReadBody | null = null;
    try {
      const response = await this.env.SESSION.getByName(sessionId).fetch(
        new Request(`http://session${SessionInternalPaths.piBrowserRead}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(operationId ? { "X-Pi-Operation-ID": operationId } : {}),
            ...(operationId ? piTraceHeader(operationId) : {}),
          },
          body: JSON.stringify({ action: request.action, url: request.url }),
          signal,
        })
      );
      body = (await response.json().catch(() => null)) as BrowserReadBody | null;
      if (!response.ok || !body?.allowed || !body.outcome) {
        return {
          allowed: false,
          reason: body?.reason ?? "The page could not be loaded",
        };
      }
    } catch {
      // The session's own string stays inside the platform. The model only
      // learns that the page did not load.
      return { allowed: false, reason: "The page could not be loaded" };
    }
    return { allowed: true, outcome: body.outcome };
  }

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
    const cost = this.prices.costOf(model, usage);
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
    if (!declaration) throw new Error(`Tool has no effect declaration: ${name}`);
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

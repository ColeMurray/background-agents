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
import { translatePiEvents } from "../pi/event-translator";
import {
  toPiModel,
  toPiThinkingLevel,
  type PiRuntimePrompt,
  type PiRuntimeOperationStatus,
  type PiRuntimeReceipt,
  type PiRuntimeResult,
  type PiRuntimeUsage,
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
  PI_REPOSITORY_MAX_FILES,
  type PiRepositoryMaterialization,
  type PiRepositoryMaterializationManifest,
} from "../pi/repository-materialization-contract";
import { createOpenInspectExtension, createSubagentExtension } from "../pi/open-inspect-extension";
import { skillSourceFromInstallation } from "../pi/skill-source";
import { createManagedSkillsExtension } from "../pi/managed-skills-extension";
import { createComputerWorkspaceCapability } from "../pi/computer-workspace-extension";
import {
  COMPUTER_SCRATCH_ROOT,
  WorkspaceMutationFifo,
  createQuotaWorkspace,
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
  type ExternalActionPrepareRequest,
} from "@open-inspect/shared";
import { createExternalActionPolicyDelegate } from "../pi/external-action-policy-extension";
import {
  createOpenInspectCodemodeExtension,
  createPiCodeModePolicyDelegate,
  createPiCodeModePolicyState,
} from "../pi/codemode-extension";
import type { SessionDiffUpload } from "@open-inspect/shared/types/session-diffs";
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

type PiWorkerBindings = Pick<WorkerBindings, "SESSION" | "CODEMODE_SANDBOX">;

const SESSION_ID_KEY = "open-inspect:session-id";
const DELETION_STATE_KEY = "open-inspect:deletion-state";
const REPOSITORY_PINS_KEY = "open-inspect:repository-pins";
const ROOT_SESSION = "1";
const OPERATION_METADATA_PREFIX = "open-inspect:operation:";
const MAX_OPERATION_METADATA_TOMBSTONES = 128;

interface PiOperationMetadata {
  readonly model: string;
  readonly baseline: PiAccountingSnapshot;
  readonly projectedCostUsd: number;
  readonly settledAt?: number;
}
/** OpenCode-free, sandbox-free Pi runtime for one Open-Inspect session. */
export class PiSessionDO extends DurableObject<PiWorkerBindings> {
  private readonly credentials = new CodexBrokerCredentialStore((version, signal) =>
    this.fetchCodexCredential(version, signal)
  );
  private readonly models = createModels({ credentials: this.credentials });
  private readonly registry = createRegistry();
  private workspace: Workspace | undefined;
  private codemodeSandbox: RemoteCodemodeSandbox | undefined;
  private rawWorkspace: Workspace | undefined;
  private repositoryWorkspace: PiRepositoryWorkspace | undefined;
  private harnessOpened = false;
  private readonly eventStreams = new Map<string, AgentEventStream>();
  private readonly eventRelayWork = new Map<string, Promise<void>>();
  readonly projectionOutbox = new PiProjectionOutbox(
    this.ctx.storage.sql,
    (sequence, displayId, operationId, event) =>
      this.deliverEventProjection(sequence, displayId, operationId, event)
  );
  readonly harness = new PiHarness({
    harness: async ({ storage, context }) => {
      const snapshot = await readPiFeatureCapabilitySnapshot(this.ctx.storage);
      if (!snapshot) throw new Error("Pi Durable capability authority is not initialized");
      const { capabilities } = snapshot;
      const sessionContext = await this.fetchSessionContext();
      const codeModePolicy = createPiCodeModePolicyState();
      const codeModePolicyDelegate = createPiCodeModePolicyDelegate(codeModePolicy);
      const emergencyPolicy = createPiDeploymentEmergencyPolicy(
        async (signal) =>
          (await this.fetchCapabilityAuthorityForStoredSession(signal)).current.capabilities
      );
      const core = createOpenInspectExtension({
        repositories: sessionContext.repositories,
        invokeRepository: (tool, args, signal) => this.invokeRepositoryTool(tool, args, signal),
      });
      const delegation = createSubagentExtension();
      let workspacePolicyDelegate: PiToolPolicyDelegate | undefined;
      const workspaceMutations = new WorkspaceMutationFifo();
      const extensions: PiExtensionContribution[] = [
        {
          slot: "policy",
          effects: [],
          createExtension: (effects) => {
            const externalActionDelegate = createExternalActionPolicyDelegate({
              client: {
                prepare: (request, signal) => this.prepareExternalAction(request, signal),
                status: (actionId, signal) => this.externalActionStatus(actionId, signal),
                execute: (actionId, signal) => this.executeExternalAction(actionId, signal),
              },
              // Provider-specific tools are contributed to the external_actions
              // slot together with their canonical effect registrations.
              externalActions: {},
            });
            return createPiToolPolicyExtension(
              effects,
              workspacePolicyDelegate
                ? [externalActionDelegate, workspacePolicyDelegate, codeModePolicyDelegate]
                : [externalActionDelegate, codeModePolicyDelegate],
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
        const scratchWorkspace = await this.openWorkspace(capabilities.workspace === "enabled");
        const rawWorkspace = this.rawWorkspace;
        if (!rawWorkspace) throw new Error("Pi repository workspace is unavailable");
        const repositoryWorkspace = new PiRepositoryWorkspace(
          rawWorkspace.fs as unknown as ConstructorParameters<typeof PiRepositoryWorkspace>[0],
          () => Date.now(),
          { mutations: workspaceMutations }
        );
        const restorePlan = await repositoryWorkspace.restore(sessionContext.repositories);
        if (restorePlan.materializePositions.length > 0) {
          const materializePositions = new Set(restorePlan.materializePositions);
          const manifests: PiRepositoryMaterializationManifest[] = [];
          let materializedFiles = restorePlan.restoredFileCount;
          for (const repository of sessionContext.repositories) {
            if (!materializePositions.has(repository.position)) continue;
            const manifest = await this.fetchRepositoryMaterializationManifest(
              repository.position,
              repository.commitSha
            );
            materializedFiles += manifest.files.length;
            if (materializedFiles > PI_REPOSITORY_MAX_FILES) {
              throw new Error("Pi repository set exceeds the 1000 file materialization limit");
            }
            manifests.push(manifest);
          }
          for (const manifest of manifests) {
            await repositoryWorkspace.materialize([
              await this.fetchRepositoryMaterialization(manifest),
            ]);
          }
        }
        this.repositoryWorkspace = repositoryWorkspace;
        const capability = createRepositoryEditingWorkspaceCapability({
          scratchWorkspace,
          repositoryWorkspace: rawWorkspace,
          overlay: repositoryWorkspace,
          mutations: workspaceMutations,
          scratchMode: capabilities.workspace,
          publishDiff: (bundle) => this.publishDiffBundle(bundle),
          triggerMessageId: () => this.currentOperationId(),
        });
        workspacePolicyDelegate = capability.toolPolicyDelegate;
        extensions.push({
          slot: "workspace",
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
      } else if (capabilities.workspace !== "off") {
        const workspace = await this.openWorkspace(capabilities.workspace === "enabled");
        const capability = createComputerWorkspaceCapability(
          workspace,
          capabilities.workspace,
          workspaceMutations
        );
        workspacePolicyDelegate = capability.toolPolicyDelegate;
        extensions.push({
          slot: "workspace",
          feature: "workspace",
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
      const assembly = assemblePiExtensions(extensions, capabilities);
      for (const extension of assembly.extensions) this.registry.install(extension);
      this.models.setProvider(openaiCodexProvider());
      const opened = await Harness.open(
        storage,
        {
          models: this.models,
          registry: this.registry,
        },
        context
      );
      this.harnessOpened = true;
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
  readonly lifecycle = Lifecycle.install(this).use(this.harness).use(this.projector);

  async initialize(sessionId: string, input: PiFeatureCapabilitySnapshot): Promise<void> {
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
  }

  async onStart(): Promise<void> {
    if (await this.ctx.storage.get<string>(DELETION_STATE_KEY)) return;
    const sessionId = await this.ctx.storage.get<string>(SESSION_ID_KEY);
    if (!sessionId) return;
    await this.ensureSession(sessionId);
    const pending = await this.harness.pending({ session: ROOT_SESSION });
    await Promise.all(
      pending.map((operation) =>
        this.startEventRelay(sessionId, operation.operationId, {
          recoverSnapshot: operation.status === "running",
        })
      )
    );
  }

  async submit(input: PiRuntimePrompt): Promise<PiRuntimeReceipt> {
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
      await Promise.all(
        [...this.eventStreams.keys()].map((operationId) => this.stopEventRelay(operationId))
      );
      if (deletionState !== "destroying") {
        await this.ctx.storage.put(DELETION_STATE_KEY, "destroying");
        // A cold object has no live code to abort. Opening its harness here can
        // require repository rematerialization and make deletion depend on an
        // external provider that may be unavailable or revoked.
        if (this.harnessOpened) await this.harness.abort({ session: ROOT_SESSION });
      }
      await this.lifecycle.disableAlarms();
      if (this.harnessOpened) await this.harness.dispose();
      this.harnessOpened = false;
      await this.codemodeSandbox?.close();
      this.codemodeSandbox = undefined;
      await (this.rawWorkspace ?? this.workspace)?.close();
      this.workspace = undefined;
      this.rawWorkspace = undefined;
      this.repositoryWorkspace = undefined;
      this.credentials.clear();
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.put(DELETION_STATE_KEY, "destroyed");
    });
  }

  async refreshDiff(sessionId: string): Promise<void> {
    await this.ensureSession(sessionId);
    await this.harness.pi();
    if (!this.repositoryWorkspace) throw new Error("Pi repository editing is not enabled");
    await this.publishDiffBundle(await this.repositoryWorkspace.captureDiff(null));
  }

  private async openWorkspace(writable: boolean): Promise<Workspace> {
    if (this.workspace) return this.workspace;
    const workspace = new Workspace({
      storage: this.ctx.storage as unknown as DurableObjectStorageLike,
      sessionId: this.ctx.id.toString(),
    });
    try {
      await workspace.fs.mkdir(COMPUTER_SCRATCH_ROOT, { recursive: true });
      await workspace.fs.mkdir("/workspace/repos", { recursive: true });
    } catch (error) {
      await workspace.close().catch(() => {});
      throw error;
    }
    this.rawWorkspace = workspace;
    this.workspace = writable ? createQuotaWorkspace(workspace, this.ctx.storage) : workspace;
    return this.workspace;
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
    if (await this.ctx.storage.get<string>(DELETION_STATE_KEY)) {
      throw new Error("Pi Durable session was deleted");
    }
    const sessionId = await this.ctx.storage.get<string>(SESSION_ID_KEY);
    if (!sessionId) throw new Error("Pi Durable session is not initialized");
    const operation = (await this.harness.pending({ session: ROOT_SESSION }))[0];
    if (!operation) throw new Error("Pi Durable has no active operation");
    const stub = this.env.SESSION.getByName(sessionId);
    const response = await stub.fetch(
      new Request(`http://session${SessionInternalPaths.piCredential}`, {
        method: "POST",
        headers: {
          "X-Pi-Operation-ID": operation.operationId,
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
    return {
      accessToken: body.access_token,
      expiresIn: body.expires_in,
      credentialVersion: body.credential_version,
    };
  }

  private async fetchSessionContext(): Promise<PiSessionContext> {
    if (await this.ctx.storage.get<string>(DELETION_STATE_KEY)) {
      throw new Error("Pi Durable session was deleted");
    }
    const sessionId = await this.ctx.storage.get<string>(SESSION_ID_KEY);
    if (!sessionId) throw new Error("Pi Durable session is not initialized");
    const storedPinsValue = await this.ctx.storage.get<unknown>(REPOSITORY_PINS_KEY);
    const storedPins =
      storedPinsValue === undefined ? undefined : piRepositoryPinsSchema.parse(storedPinsValue);
    const response = await this.env.SESSION.getByName(sessionId).fetch(
      new Request(`http://session${SessionInternalPaths.piContext}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repositoryPins: storedPins }),
      })
    );
    if (!response.ok) throw new Error(`Pi session context unavailable (${response.status})`);
    const sessionContext = piSessionContextSchema.parse(await response.json());
    if (storedPins === undefined) {
      await this.ctx.storage.put(
        REPOSITORY_PINS_KEY,
        sessionContext.repositories.map(({ repoOwner, repoName, position, commitSha }) => ({
          repoOwner,
          repoName,
          position,
          commitSha,
        }))
      );
      return sessionContext;
    }
    const byPosition = new Map(storedPins.map((pin) => [pin.position, pin]));
    return {
      ...sessionContext,
      repositories: sessionContext.repositories.map((repository) => {
        const pin = byPosition.get(repository.position);
        if (
          !pin ||
          pin.repoOwner !== repository.repoOwner ||
          pin.repoName !== repository.repoName
        ) {
          throw new Error("Pi repository pin does not match the session repository set");
        }
        return { ...repository, commitSha: pin.commitSha };
      }),
    };
  }

  private async invokeRepositoryTool(
    tool: "repository_list" | "repository_read",
    args: Record<string, JsonValue | undefined>,
    signal?: AbortSignal
  ) {
    const sessionId = await this.ctx.storage.get<string>(SESSION_ID_KEY);
    if (!sessionId) throw new Error("Pi Durable session is not initialized");
    const operation = (await this.harness.pending({ session: ROOT_SESSION }))[0];
    if (!operation) throw new Error("Pi Durable has no active operation");
    const response = await this.env.SESSION.getByName(sessionId).fetch(
      new Request(`http://session${SessionInternalPaths.piRepositoryTool}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Pi-Operation-ID": operation.operationId,
        },
        body: JSON.stringify({ tool, arguments: args }),
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
    const operation = (await this.harness.pending({ session: ROOT_SESSION }))[0];
    if (!operation) throw new Error("Pi Durable has no active operation");
    const response = await this.env.SESSION.getByName(sessionId).fetch(
      new Request(`http://session${path}${search}`, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          "X-Pi-Operation-ID": operation.operationId,
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
    commitSha: string
  ): Promise<PiRepositoryMaterializationManifest> {
    return piRepositoryMaterializationManifestSchema.parse(
      await this.fetchRepositoryMaterializationPart({
        operation: "manifest",
        repository,
        commitSha,
      })
    );
  }

  private async fetchRepositoryMaterialization(
    manifest: PiRepositoryMaterializationManifest
  ): Promise<PiRepositoryMaterialization> {
    const repository = manifest.repository.position;
    const commitSha = manifest.repository.commitSha;
    const files: PiRepositoryMaterialization["files"] = [];
    let offset = 0;
    let totalBytes = 0;
    while (offset < manifest.files.length) {
      const batch = piRepositoryMaterializationBatchSchema.parse(
        await this.fetchRepositoryMaterializationPart({
          operation: "files",
          repository,
          commitSha,
          offset,
        })
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
    body: Record<string, unknown>
  ): Promise<unknown> {
    const sessionId = await this.ctx.storage.get<string>(SESSION_ID_KEY);
    if (!sessionId) throw new Error("Pi Durable session is not initialized");
    const response = await this.env.SESSION.getByName(sessionId).fetch(
      new Request(`http://session${SessionInternalPaths.piRepositoryMaterialization}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    );
    if (!response.ok) throw new Error(`Repository materialization failed (${response.status})`);
    return response.json();
  }

  private async currentOperationId(): Promise<string | null> {
    return (await this.harness.pending({ session: ROOT_SESSION }))[0]?.operationId ?? null;
  }

  private async publishDiffBundle(bundle: SessionDiffUpload): Promise<void> {
    const sessionId = await this.ctx.storage.get<string>(SESSION_ID_KEY);
    if (!sessionId) throw new Error("Pi Durable session is not initialized");
    const response = await this.env.SESSION.getByName(sessionId).fetch(
      new Request(`http://session${SessionInternalPaths.diffStore}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bundle),
      })
    );
    if (!response.ok) {
      const message = `Pi diff publication failed (${response.status})`;
      await this.recordDiffFailure(sessionId, message).catch(() => {});
      throw new Error(message);
    }
  }

  private async recordDiffFailure(sessionId: string, error: string): Promise<void> {
    await this.env.SESSION.getByName(sessionId).fetch(
      new Request(`http://session${SessionInternalPaths.diffFailure}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error }),
      })
    );
  }

  private async startEventRelay(
    sessionId: string,
    operationId: string,
    options: { recoverSnapshot?: boolean } = {}
  ): Promise<void> {
    if (this.eventStreams.has(operationId)) return;
    const stream = await this.harness.session(ROOT_SESSION).events(BACKGROUND_CONTEXT);
    const metadata = await this.operationMetadata(operationId);
    if (!metadata) throw new Error("Pi operation metadata is unavailable");
    const state = { text: "", tools: new Map() };
    const queue = (events: readonly AgentEvent[]) => {
      const previous = (this.eventRelayWork.get(operationId) ?? Promise.resolve()).catch(() => {});
      const work = previous.then(async () => {
        for (const source of events) {
          const translated = translatePiEvents([source], state, {
            sessionId,
            operationId,
            timestamp: Date.now() / 1_000,
          });
          const sourceIdentity = piAgentEventIdentity(source);
          const accounting =
            source.type === "usage_changed" ||
            source.type === "snapshot" ||
            source.type === "tool_execution_end" ||
            source.type === "compaction_end" ||
            translated.some((event) => event.type === "step_finish")
              ? await this.observeOperationAccounting(operationId)
              : undefined;
          for (const event of translated) {
            this.projectionOutbox.enqueue(
              piProjectionIdentity(operationId, event, sourceIdentity),
              operationId,
              this.priceStepEvent(event, metadata.model, accounting?.costUsd),
              Date.now()
            );
          }
          if (accounting?.changed) {
            const event = accountingProjectionEvent(sessionId, operationId, accounting.costUsd);
            this.projectionOutbox.enqueue(
              piProjectionIdentity(operationId, event),
              operationId,
              event,
              Date.now()
            );
            await this.recordProjectedCost(operationId, accounting.costUsd);
          }
        }
      });
      this.eventRelayWork.set(operationId, work);
      return work;
    };
    this.eventStreams.set(operationId, stream);
    if (options.recoverSnapshot) void queue([stream.snapshot]).catch(() => {});
    stream.start((events) => queue(events).catch(() => {}));
    void stream.closed.then(() => this.eventStreams.delete(operationId));
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
    const stream = this.eventStreams.get(operationId);
    if (stream) {
      this.eventStreams.delete(operationId);
      await stream.stop();
    }
    try {
      await this.eventRelayWork.get(operationId);
    } catch {
      // Terminal projection below is the durable backstop for a failed live relay.
    } finally {
      this.eventRelayWork.delete(operationId);
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
  }
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

import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Workspace, type DurableObjectStorageLike } from "@cloudflare/computer";
import { PI_TOOL_EFFECT_REGISTRY, type ToolEffectRegistration } from "@open-inspect/shared";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import {
  createRegistry,
  Harness,
  type AgentEvent,
  type AgentEventStream,
} from "@earendil-works/pi-durable";
import { DurableObject } from "cloudflare:workers";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { SessionInternalPaths } from "../session/contracts";
import { CodexBrokerCredentialStore } from "../pi/codex-credential-store";
import { PiProjectionCapability } from "../pi/projection-capability";
import { RetryablePiProjectionError } from "../pi/projection-retry-policy";
import { translatePiEvents } from "../pi/event-translator";
import {
  toPiModel,
  toPiThinkingLevel,
  type PiRuntimePrompt,
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
import { createOpenInspectExtension, createSubagentExtension } from "../pi/open-inspect-extension";
import { skillSourceFromInstallation } from "../pi/skill-source";
import { createManagedSkillsExtension } from "../pi/managed-skills-extension";
import { createComputerWorkspaceExtension } from "../pi/computer-workspace-extension";
import { assemblePiExtensions, type PiExtensionContribution } from "../pi/extension-assembler";
import { createPiToolPolicyExtension } from "../pi/tool-policy-extension";
import { latchPiFeatureCapabilitySnapshot } from "../pi/capability-snapshot";
import { z } from "zod";

type PiWorkerBindings = Pick<
  WorkerBindings,
  | "SESSION"
  | "PI_WORKSPACE_MODE"
  | "PI_REPOSITORY_EDITING_MODE"
  | "PI_CODE_MODE"
  | "PI_SANDBOX_EXECUTION_MODE"
  | "PI_EXTERNAL_ACTIONS_MODE"
  | "PI_MCP_MODE"
>;

const SESSION_ID_KEY = "open-inspect:session-id";
const DELETION_STATE_KEY = "open-inspect:deletion-state";
const REPOSITORY_PINS_KEY = "open-inspect:repository-pins";
const ROOT_SESSION = "1";
const EVENT_DELIVERY_ATTEMPTS = 3;
const EVENT_DELIVERY_RETRY_MS = 100;
/** OpenCode-free, sandbox-free Pi runtime for one Open-Inspect session. */
export class PiSessionDO extends DurableObject<PiWorkerBindings> {
  private readonly credentials = new CodexBrokerCredentialStore((version, signal) =>
    this.fetchCodexCredential(version, signal)
  );
  private readonly models = createModels({ credentials: this.credentials });
  private readonly registry = createRegistry();
  private workspace: Workspace | undefined;
  private readonly eventStreams = new Map<string, AgentEventStream>();
  private readonly eventRelayWork = new Map<string, Promise<void>>();
  readonly harness = new PiHarness({
    harness: async ({ storage, context }) => {
      const sessionContext = await this.fetchSessionContext();
      const { capabilities } = await latchPiFeatureCapabilitySnapshot(this.ctx.storage, {
        workspace: this.env.PI_WORKSPACE_MODE,
        repositoryEditing: this.env.PI_REPOSITORY_EDITING_MODE,
        codeMode: this.env.PI_CODE_MODE,
        sandboxExecution: this.env.PI_SANDBOX_EXECUTION_MODE,
        externalActions: this.env.PI_EXTERNAL_ACTIONS_MODE,
        mcp: this.env.PI_MCP_MODE,
      });
      const core = createOpenInspectExtension({
        repositories: sessionContext.repositories,
        invokeRepository: (tool, args, signal) => this.invokeRepositoryTool(tool, args, signal),
      });
      const delegation = createSubagentExtension();
      const extensions: PiExtensionContribution[] = [
        {
          slot: "policy",
          effects: [],
          createExtension: createPiToolPolicyExtension,
        },
        { slot: "core", extension: core, effects: declaredEffects(core) },
        {
          slot: "delegation",
          extension: delegation,
          effects: declaredEffects(delegation),
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
      if (capabilities.workspace !== "off") {
        const workspace = await this.openWorkspace();
        const workspaceExtension = createComputerWorkspaceExtension(workspace);
        extensions.push({
          slot: "workspace",
          feature: "workspace",
          minimumCapability: "read_only",
          extension: workspaceExtension,
          effects: declaredEffects(workspaceExtension),
        });
      }
      const assembly = assemblePiExtensions(extensions, capabilities);
      for (const extension of assembly.extensions) this.registry.install(extension);
      this.models.setProvider(openaiCodexProvider());
      return Harness.open(
        storage,
        {
          models: this.models,
          registry: this.registry,
        },
        context
      );
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
    result: (operationId, usageBaseline) => this.waitForResult(operationId, usageBaseline),
    deliver: async (sessionId, result) => {
      await this.stopEventRelay(result.operationId);
      await this.deliverResult(sessionId, result);
    },
  });
  readonly lifecycle = Lifecycle.install(this).use(this.harness).use(this.projector);

  async onStart(): Promise<void> {
    if (await this.ctx.storage.get<string>(DELETION_STATE_KEY)) return;
    const sessionId = await this.ctx.storage.get<string>(SESSION_ID_KEY);
    if (!sessionId) return;
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
      await this.startEventRelay(input.sessionId, input.messageId);
      await this.projector.schedule({
        sessionId: input.sessionId,
        operationId: input.messageId,
        usageBaseline: await this.usageTotals(),
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

  private async waitForResult(
    operationId: string,
    usageBaseline: PiRuntimeUsage
  ): Promise<PiRuntimeResult> {
    const result = await this.harness.wait(operationId, { session: ROOT_SESSION });
    const usage =
      result.status === "done" ? subtractUsage(await this.usageTotals(), usageBaseline) : undefined;
    return {
      operationId,
      status: result.status,
      text: result.status === "done" ? (result.text ?? "") : "",
      ...(result.status === "unanswered" ? { reason: result.reason } : {}),
      ...(usage ? { usage } : {}),
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
        // A cold abort opens Pi and may load its SessionDO-owned context. Mark
        // deletion only after that open succeeds; retries after this point skip
        // reopening and continue the idempotent teardown.
        await this.harness.abort({ session: ROOT_SESSION });
        await this.ctx.storage.put(DELETION_STATE_KEY, "destroying");
      }
      await this.lifecycle.disableAlarms();
      await this.harness.dispose();
      await this.workspace?.close();
      this.workspace = undefined;
      this.credentials.clear();
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.put(DELETION_STATE_KEY, "destroyed");
    });
  }

  private async openWorkspace(): Promise<Workspace> {
    if (this.workspace) return this.workspace;
    const workspace = new Workspace({
      storage: this.ctx.storage as unknown as DurableObjectStorageLike,
      sessionId: this.ctx.id.toString(),
    });
    try {
      await workspace.fs.mkdir("/workspace", { recursive: true });
    } catch (error) {
      await workspace.close().catch(() => {});
      throw error;
    }
    this.workspace = workspace;
    return workspace;
  }

  private async configure(
    input: Pick<PiRuntimePrompt, "model" | "reasoningEffort">
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
  }

  private async usageTotals(): Promise<PiRuntimeUsage> {
    const state = await (await this.harness.pi()).usage(BACKGROUND_CONTEXT);
    const total: PiRuntimeUsage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    };
    for (const usage of [...Object.values(state.models), ...Object.values(state.tools)]) {
      total.input += usage.input;
      total.output += usage.output;
      total.cacheRead += usage.cacheRead;
      total.cacheWrite += usage.cacheWrite;
      total.total += usage.totalTokens;
      if (usage.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
    }
    return total;
  }

  private async ensureSession(sessionId: string): Promise<void> {
    if (await this.ctx.storage.get<string>(DELETION_STATE_KEY)) {
      throw new Error("Pi Durable session was deleted");
    }
    const stored = await this.ctx.storage.get<string>(SESSION_ID_KEY);
    if (stored === undefined) {
      await this.ctx.storage.put(SESSION_ID_KEY, sessionId);
      return;
    }
    if (stored !== sessionId) throw new Error("Pi Durable Object session identity mismatch");
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

  private async startEventRelay(
    sessionId: string,
    operationId: string,
    options: { recoverSnapshot?: boolean } = {}
  ): Promise<void> {
    if (this.eventStreams.has(operationId)) return;
    const stream = await this.harness.session(ROOT_SESSION).events(BACKGROUND_CONTEXT);
    const state = { text: "", tools: new Map() };
    const queue = (events: readonly AgentEvent[]) => {
      const previous = (this.eventRelayWork.get(operationId) ?? Promise.resolve()).catch(() => {});
      const work = previous.then(async () => {
        const translated = translatePiEvents(events, state, {
          sessionId,
          operationId,
          timestamp: Date.now() / 1_000,
        });
        for (const event of translated) await this.deliverEvent(sessionId, operationId, event);
      });
      this.eventRelayWork.set(operationId, work);
      return work;
    };
    this.eventStreams.set(operationId, stream);
    if (options.recoverSnapshot) void queue([stream.snapshot]).catch(() => {});
    stream.start((events) => queue(events).catch(() => {}));
    void stream.closed.then(() => this.eventStreams.delete(operationId));
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

  private async deliverEvent(
    sessionId: string,
    operationId: string,
    event: ReturnType<typeof translatePiEvents>[number]
  ): Promise<void> {
    let failure: unknown;
    for (let attempt = 1; attempt <= EVENT_DELIVERY_ATTEMPTS; attempt++) {
      try {
        const response = await this.env.SESSION.getByName(sessionId).fetch(
          new Request(`http://session${SessionInternalPaths.piEvent}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Pi-Operation-ID": operationId,
            },
            body: JSON.stringify(event),
          })
        );
        if (response.ok) return;
        failure = new Error(`Pi event delivery rejected (${response.status})`);
        if (response.status < 500) break;
      } catch (error) {
        failure = error;
      }
      if (attempt < EVENT_DELIVERY_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, EVENT_DELIVERY_RETRY_MS * attempt));
      }
    }
    throw failure instanceof Error ? failure : new Error("Pi event delivery failed");
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
    if (!response.ok) throw new Error(`Pi result delivery rejected (${response.status})`);
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

function subtractUsage(current: PiRuntimeUsage, baseline: PiRuntimeUsage): PiRuntimeUsage {
  return {
    input: Math.max(0, current.input - baseline.input),
    output: Math.max(0, current.output - baseline.output),
    cacheRead: Math.max(0, current.cacheRead - baseline.cacheRead),
    cacheWrite: Math.max(0, current.cacheWrite - baseline.cacheWrite),
    total: Math.max(0, current.total - baseline.total),
    ...(current.reasoning === undefined && baseline.reasoning === undefined
      ? {}
      : { reasoning: Math.max(0, (current.reasoning ?? 0) - (baseline.reasoning ?? 0)) }),
  };
}

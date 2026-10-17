import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { createRegistry, Harness, type AgentEventStream } from "@earendil-works/pi-durable";
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

type PiWorkerBindings = Pick<WorkerBindings, "SESSION">;

const SESSION_ID_KEY = "open-inspect:session-id";
const DELETION_STATE_KEY = "open-inspect:deletion-state";
const ROOT_SESSION = "1";

/** OpenCode-free, sandbox-free Pi runtime for one Open-Inspect session. */
export class PiSessionDO extends DurableObject<PiWorkerBindings> {
  private readonly credentials = new CodexBrokerCredentialStore((signal) =>
    this.fetchCodexCredential(signal)
  );
  private readonly models = createModels({ credentials: this.credentials });
  private readonly registry = createRegistry();
  private readonly eventStreams = new Map<string, AgentEventStream>();
  private readonly eventRelayWork = new Map<string, Promise<void>>();
  readonly harness = new PiHarness({
    harness: ({ storage, context }) => {
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

  async submit(input: PiRuntimePrompt): Promise<PiRuntimeReceipt> {
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
      if ((await this.ctx.storage.get<string>(DELETION_STATE_KEY)) === "destroyed") return;
      const stored = await this.ctx.storage.get<string>(SESSION_ID_KEY);
      if (stored !== undefined && stored !== sessionId) {
        throw new Error("Pi Durable Object session identity mismatch");
      }
      await this.ctx.storage.put(DELETION_STATE_KEY, "destroying");
      await Promise.all(
        [...this.eventStreams.keys()].map((operationId) => this.stopEventRelay(operationId))
      );
      await this.harness.abort({ session: ROOT_SESSION });
      await this.harness.dispose();
      this.credentials.clear();
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.put(DELETION_STATE_KEY, "destroyed");
    });
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

  private async fetchCodexCredential(signal?: AbortSignal) {
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
        headers: { "X-Pi-Operation-ID": operation.operationId },
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
      typeof body.expires_in !== "number"
    ) {
      throw new Error("Invalid OpenAI credential broker response");
    }
    return { accessToken: body.access_token, expiresIn: body.expires_in };
  }

  private async startEventRelay(sessionId: string, operationId: string): Promise<void> {
    if (this.eventStreams.has(operationId)) return;
    const stream = await this.harness.session(ROOT_SESSION).events(BACKGROUND_CONTEXT);
    const state = { text: "" };
    stream.start(async (events) => {
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
      await work;
    });
    this.eventStreams.set(operationId, stream);
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
    if (!response.ok) throw new Error(`Pi event delivery rejected (${response.status})`);
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

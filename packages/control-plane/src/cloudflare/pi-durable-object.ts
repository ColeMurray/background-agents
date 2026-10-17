import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { DurableObject } from "cloudflare:workers";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { SessionInternalPaths } from "../session/contracts";
import { CodexBrokerCredentialStore } from "../pi/codex-credential-store";
import { PiProjectionCapability } from "../pi/projection-capability";
import {
  toPiModel,
  toPiThinkingLevel,
  type PiRuntimePrompt,
  type PiRuntimeReceipt,
  type PiRuntimeResult,
} from "../pi/runtime-contract";
import type { WorkerBindings } from "./platform";

type PiWorkerBindings = Pick<WorkerBindings, "SESSION">;

const SESSION_ID_KEY = "open-inspect:session-id";
const ROOT_SESSION = "1";

/** OpenCode-free, sandbox-free Pi runtime for one Open-Inspect session. */
export class PiSessionDO extends DurableObject<PiWorkerBindings> {
  private readonly credentials = new CodexBrokerCredentialStore((signal) =>
    this.fetchCodexCredential(signal)
  );
  private readonly models = createModels({ credentials: this.credentials });
  private readonly registry = createRegistry();
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
    result: (operationId) => this.waitForResult(operationId),
    deliver: (sessionId, result) => this.deliverResult(sessionId, result),
  });
  readonly lifecycle = Lifecycle.install(this).use(this.harness).use(this.projector);

  async submit(input: PiRuntimePrompt): Promise<PiRuntimeReceipt> {
    await this.ensureSession(input.sessionId);
    await this.configure(input);
    await this.projector.schedule({ sessionId: input.sessionId, operationId: input.messageId });
    const receipt = await this.harness.submit(input.content, {
      session: ROOT_SESSION,
      operationId: input.messageId,
    });
    return { operationId: receipt.operationId, accepted: receipt.accepted };
  }

  private async waitForResult(operationId: string): Promise<PiRuntimeResult> {
    const result = await this.harness.wait(operationId, { session: ROOT_SESSION });
    return {
      operationId,
      status: result.status,
      text: result.status === "done" ? (result.text ?? "") : "",
      ...(result.status === "unanswered" ? { reason: result.reason } : {}),
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

  private async ensureSession(sessionId: string): Promise<void> {
    const stored = await this.ctx.storage.get<string>(SESSION_ID_KEY);
    if (stored === undefined) {
      await this.ctx.storage.put(SESSION_ID_KEY, sessionId);
      return;
    }
    if (stored !== sessionId) throw new Error("Pi Durable Object session identity mismatch");
  }

  private async fetchCodexCredential(signal?: AbortSignal) {
    const sessionId = await this.ctx.storage.get<string>(SESSION_ID_KEY);
    if (!sessionId) throw new Error("Pi Durable session is not initialized");
    const stub = this.env.SESSION.getByName(sessionId);
    const response = await stub.fetch(
      new Request(`http://session${SessionInternalPaths.piCredential}`, {
        method: "POST",
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

  private async deliverResult(sessionId: string, result: PiRuntimeResult): Promise<void> {
    const response = await this.env.SESSION.getByName(sessionId).fetch(
      new Request(`http://session${SessionInternalPaths.piResult}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(result),
      })
    );
    if (!response.ok) throw new Error(`Pi result delivery failed (${response.status})`);
  }
}

import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type Provider,
  type Usage,
} from "@earendil-works/pi-ai";
import type { HarnessUsage } from "../harness/pricing";

export type TrustedUsageRecorder = (modelId: string, usage: HarnessUsage) => Promise<void>;

/** Meter a provider response before its terminal event reaches the harness. */
export function createAccountingProvider(
  provider: Provider,
  record: TrustedUsageRecorder
): Provider {
  return {
    ...provider,
    stream: (model, context, options) =>
      meteredStream(provider.stream(model, context, options), model, record),
    streamSimple: (model, context, options) =>
      meteredStream(provider.streamSimple(model, context, options), model, record),
  };
}

function meteredStream(
  source: AssistantMessageEventStream,
  model: Model<Api>,
  record: TrustedUsageRecorder
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  void (async () => {
    for await (const event of source) {
      if (event.type !== "done") {
        output.push(event);
        continue;
      }
      try {
        await record(`openai/${model.id}`, toHarnessUsage(event.message.usage));
        output.push(event);
      } catch {
        output.push({
          type: "error",
          reason: "error",
          error: accountingFailure(event.message),
        });
      }
    }
  })();
  return output;
}

function toHarnessUsage(usage: Usage): HarnessUsage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    total: usage.totalTokens,
    ...(usage.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
  };
}

function accountingFailure(message: AssistantMessage): AssistantMessage {
  return {
    ...message,
    stopReason: "error",
    errorMessage: "Trusted usage accounting failed",
  };
}

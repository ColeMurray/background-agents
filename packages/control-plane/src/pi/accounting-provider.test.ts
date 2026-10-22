import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type Provider } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createAccountingProvider } from "./accounting-provider";

describe("createAccountingProvider", () => {
  it("records server-priced usage before exposing the terminal model event", async () => {
    const faux = fauxProvider();
    const source = createAssistantMessageEventStream();
    const provider = {
      ...faux.provider,
      stream: vi.fn(() => source),
      streamSimple: vi.fn(() => source),
    } satisfies Provider;
    let release!: () => void;
    const record = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const metered = createAccountingProvider(provider, record);
    const model = provider.getModels()[0]!;
    const output = metered.streamSimple(model, {} as never);
    const message = fauxAssistantMessage("done");

    source.push({ type: "start", partial: message });
    source.push({ type: "done", reason: "stop", message });
    await vi.waitFor(() => expect(record).toHaveBeenCalledOnce());
    let settled = false;
    void output.result().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    release();
    await expect(output.result()).resolves.toEqual(message);
    expect(record).toHaveBeenCalledWith(
      `openai/${model.id}`,
      expect.objectContaining({ total: message.usage.totalTokens })
    );
  });
});

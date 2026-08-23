import { describe, expect, it } from "vitest";
import { consumeControlPlaneQueue } from "./queue-consumer";
import type { Env } from "./types";

describe("control-plane Queue dispatcher", () => {
  it("rejects unknown queue names instead of falling through to another consumer", async () => {
    const batch = {
      queue: "open-inspect-unknown-test",
      messages: [],
    } as unknown as MessageBatch<unknown>;

    await expect(
      consumeControlPlaneQueue(batch, {} as Env, {} as ExecutionContext)
    ).rejects.toThrow("Unsupported control-plane queue: open-inspect-unknown-test");
  });
});

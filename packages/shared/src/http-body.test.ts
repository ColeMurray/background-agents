import { describe, expect, it } from "vitest";

import { readBodyCapped } from "./http-body";

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe("readBodyCapped", () => {
  it("reads a missing body as zero bytes", async () => {
    expect(await readBodyCapped(null, 10)).toEqual(new Uint8Array());
  });

  it("concatenates chunks in order under the cap", async () => {
    const body = await readBodyCapped(
      streamOf(new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5])),
      5
    );
    expect(body).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it("returns null and cancels the stream once the cap is exceeded", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(4));
      },
      cancel() {
        cancelled = true;
      },
    });
    expect(await readBodyCapped(stream, 7)).toBeNull();
    expect(cancelled).toBe(true);
  });
});

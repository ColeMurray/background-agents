import { describe, expect, it } from "vitest";
import { readBoundedBytes } from "./bounded-body";

describe("readBoundedBytes", () => {
  it("returns an empty body when no stream is present", async () => {
    await expect(readBoundedBytes(null, 10)).resolves.toEqual({
      ok: true,
      bytes: new Uint8Array(),
    });
  });

  it("combines chunks within the byte limit and releases the reader", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3]));
        controller.close();
      },
    });

    await expect(readBoundedBytes(stream, 3)).resolves.toEqual({
      ok: true,
      bytes: new Uint8Array([1, 2, 3]),
    });
    expect(stream.locked).toBe(false);
  });

  it("cancels a body declared over the limit", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });

    await expect(readBoundedBytes(stream, 3, "4")).resolves.toEqual({
      ok: false,
      byteLength: 4,
    });
    expect(cancelled).toBe(true);
  });

  it("cancels an undeclared body as soon as it crosses the limit", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(readBoundedBytes(stream, 3)).resolves.toEqual({
      ok: false,
      byteLength: 4,
    });
    expect(cancelled).toBe(true);
    expect(stream.locked).toBe(false);
  });
});

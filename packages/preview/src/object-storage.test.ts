import { describe, expect, it } from "vitest";
import { createPreviewObjectStorage } from "./object-storage";

describe("preview object storage", () => {
  it("copies values, preserves metadata, ranges, replacement accounting and deletion", async () => {
    const storage = createPreviewObjectStorage(6);
    const bytes = new Uint8Array([65, 66, 67, 68]);
    await storage.put("a", bytes.subarray(1, 3), { contentType: "text/plain" });
    bytes.fill(0);
    const head = await storage.head("a");
    expect(head?.size).toBe(2);
    expect(head?.httpEtag).toMatch(/^"[a-f0-9]{64}"$/);
    const headers = new Headers();
    head?.writeHttpMetadata(headers);
    expect(headers.get("content-type")).toBe("text/plain");
    expect(await new Response((await storage.get("a"))!.body).text()).toBe("BC");
    await storage.put("a", "abcdef");
    expect(
      await new Response((await storage.get("a", { range: { offset: 2, length: 2 } }))!.body).text()
    ).toBe("cd");
    await expect(storage.put("b", "x")).rejects.toThrow("capacity");
    await expect(storage.put("a", "too long")).rejects.toThrow("capacity");
    expect((await storage.head("a"))?.size).toBe(6);
    await storage.delete("a");
    await storage.delete("a");
    expect(await storage.head("a")).toBeNull();
    expect(await storage.get("a")).toBeNull();
    await storage.put("b", "123456");
  });
  it("bounds streamed input and rejects invalid ranges", async () => {
    const storage = createPreviewObjectStorage(4);
    let cancelled = false;
    const stream = new ReadableStream({
      pull(c) {
        c.enqueue(new Uint8Array(5));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(storage.put("large", stream)).rejects.toThrow("capacity");
    expect(cancelled).toBe(true);
    expect(await storage.head("large")).toBeNull();
    await storage.put("small", new Response("abc").body!);
    await expect(storage.get("small", { range: { offset: -1, length: 1 } })).rejects.toThrow(
      "range"
    );
  });
});

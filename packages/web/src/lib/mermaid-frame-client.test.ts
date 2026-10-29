// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MAX_MERMAID_SOURCE_LENGTH, MERMAID_RENDER_TIMEOUT_MS } from "./mermaid-renderer-protocol";

const image = {
  src: "data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E",
  width: 200,
  height: 100,
};
const channels: { port1: MessagePort; port2: MessagePort }[] = [];

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  channels.length = 0;
  vi.stubGlobal(
    "MessageChannel",
    class {
      port1 = { close: vi.fn(), onmessage: null, onmessageerror: null };
      port2 = { close: vi.fn() };
      constructor() {
        channels.push(this as unknown as MessageChannel);
      }
    }
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

async function start() {
  const { renderMermaid } = await import("./mermaid-renderer");
  const result = renderMermaid("flowchart LR\n A --> B", false);
  await Promise.resolve();
  const frame = document.querySelector("iframe")!;
  const post = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
  frame.dispatchEvent(new Event("load"));
  return { renderMermaid, result, frame, post };
}

function reply(value: unknown, index = 0) {
  channels[index].port1.onmessage?.(new MessageEvent("message", { data: value }));
}

it("only sends source after an opaque-origin frame loads and accepts a private-port reply", async () => {
  const { result, frame, post } = await start();
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  expect(frame.getAttribute("src")).toBe("/mermaid-renderer.html");
  expect(frame.referrerPolicy).toBe("no-referrer");
  expect(post).toHaveBeenCalledWith({ source: "flowchart LR\n A --> B", dark: false }, "*", [
    channels[0].port2,
  ]);
  // Global window messages cannot settle the private channel.
  window.dispatchEvent(new MessageEvent("message", { data: image }));
  expect(channels[0].port1.close).not.toHaveBeenCalled();
  reply(image);
  expect(await result).toEqual(image);
  expect(channels[0].port1.close).toHaveBeenCalledOnce();
  expect(channels[0].port2.close).toHaveBeenCalledOnce();
});

it("serializes requests and reuses the loaded isolated realm across themes", async () => {
  const { result, frame, post, renderMermaid } = await start();
  const next = renderMermaid("sequenceDiagram\n A->>B: Hi", true);
  expect(post).toHaveBeenCalledOnce();
  reply(image);
  await result;
  await Promise.resolve();
  expect(document.querySelectorAll("iframe")).toHaveLength(1);
  expect(document.querySelector("iframe")).toBe(frame);
  expect(post).toHaveBeenLastCalledWith(
    { source: "sequenceDiagram\n A->>B: Hi", dark: true },
    "*",
    [channels[1].port2]
  );
  reply(image, 1);
  expect(await next).toEqual(image);
});

it.each([
  null,
  { ...image, src: "https://example.test/diagram.svg" },
  { ...image, src: "data:text/html,unsafe" },
  { ...image, width: Infinity },
  { ...image, height: -1 },
])("falls back for invalid or unsupported replies: %j", async (value) => {
  const { result } = await start();
  reply(value);
  expect(await result).toBeNull();
});

it.each(["loading", "rendering"])(
  "destroys a stalled %s frame so queued work can recover",
  async (stage) => {
    const { renderMermaid } = await import("./mermaid-renderer");
    const first = renderMermaid("flowchart LR\n Stalled --> Work", false);
    const next = renderMermaid("flowchart LR\n Next --> Work", false);
    await Promise.resolve();
    const firstFrame = document.querySelector("iframe")!;
    if (stage === "rendering") firstFrame.dispatchEvent(new Event("load"));
    await vi.advanceTimersByTimeAsync(MERMAID_RENDER_TIMEOUT_MS);
    expect(await first).toBeNull();
    expect(firstFrame.isConnected).toBe(false);
    const replacement = document.querySelector("iframe")!;
    expect(replacement).not.toBe(firstFrame);
    vi.spyOn(replacement.contentWindow!, "postMessage").mockImplementation(() => {});
    replacement.dispatchEvent(new Event("load"));
    reply(image, 1);
    expect(await next).toEqual(image);
  }
);

it("does not create a frame for oversized input", async () => {
  const { renderMermaid } = await import("./mermaid-renderer");
  expect(await renderMermaid("A".repeat(MAX_MERMAID_SOURCE_LENGTH + 1), false)).toBeNull();
  expect(document.querySelector("iframe")).toBeNull();
});

it("cleans up and releases the queue after a frame load error", async () => {
  const { result, frame } = await start();
  frame.dispatchEvent(new Event("error"));
  expect(await result).toBeNull();
  expect(frame.isConnected).toBe(false);
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
import { startPreviewBackend } from "./backend";
import { startFakeModalServer } from "../smoke/fake-modal-server.mjs";
import type * as ModalModule from "../smoke/fake-modal-server.mjs";
import { waitFor } from "./scenarios";

vi.mock("../smoke/fake-modal-server.mjs", async (original) => {
  const module = await original<typeof ModalModule>();
  return { ...module, startFakeModalServer: vi.fn(module.startFakeModalServer) };
});

it.each(["cancellation", "timeout"])(
  "closes the real host and fixtures when seeding stalls until %s",
  async (reason) => {
    const runDir = await mkdtemp(join(tmpdir(), "oi-preview-seed-abort-"));
    const controller = new AbortController();
    const nativeFetch = globalThis.fetch;
    let origin = "";
    let requestHeld = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const stalledServer = createServer(() => {
      requestHeld = true;
    });
    stalledServer.listen(0, "127.0.0.1");
    await once(stalledServer, "listening");
    const stalledOrigin = `http://127.0.0.1:${(stalledServer.address() as { port: number }).port}`;
    // Route just this seeding call to a real stalled socket, below the preview's fetch guard.
    // Native fetch owns cancellation; no successful first-party response is mocked.
    const stallFetch: typeof fetch = (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname !== "/repos") return nativeFetch(request);
      origin = url.origin;
      const signal =
        init?.signal === undefined && input instanceof Request ? input.signal : init?.signal;
      return nativeFetch(stalledOrigin, { signal });
    };
    globalThis.fetch = stallFetch;
    const starting = startPreviewBackend({
      root: resolve(import.meta.dirname, "../../../.."),
      runDir,
      webOrigin: "http://127.0.0.1:3100",
      scenario: "empty",
      signal: controller.signal,
    });
    const stopped = starting.then(
      async (backend) => {
        await backend.close();
        return new Error("Unexpected successful startup");
      },
      (error) => (error instanceof Error ? error : new Error(String(error)))
    );
    try {
      await waitFor("stalled seeding request", async () => requestHeld);
      if (reason === "cancellation") controller.abort(new Error("test requested stop"));
      const error = await Promise.race([
        stopped,
        new Promise<Error>((resolve) => {
          deadline = setTimeout(
            () => resolve(new Error("Startup never stopped")),
            reason === "cancellation" ? 3000 : 15_000
          );
        }),
      ]);
      expect(error.message).toContain(
        reason === "cancellation" ? "test requested stop" : "timeout"
      );
      expect(globalThis.fetch).toBe(stallFetch); // Guard returned ownership to its caller.
      const modal = await vi.mocked(startFakeModalServer).mock.results.at(-1)!.value;
      await expect(nativeFetch(origin)).rejects.toThrow();
      await expect(nativeFetch(modal.origin)).rejects.toThrow();
      expect(modal.activeBridges).toBe(0);
    } finally {
      clearTimeout(deadline);
      controller.abort();
      stalledServer.closeAllConnections();
      await new Promise<void>((resolve) => stalledServer.close(() => resolve()));
      try {
        await stopped;
      } finally {
        globalThis.fetch = nativeFetch;
        await rm(runDir, { recursive: true, force: true });
      }
    }
  },
  25_000
);

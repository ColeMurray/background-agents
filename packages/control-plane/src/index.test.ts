import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "./index";
import type { WorkerBindings } from "./cloudflare/platform";

// Node unit tests exercise the Worker entrypoint without loading workerd's DO base class.
vi.mock("./cloudflare/durable-object", () => ({ SessionDO: class {} }));

afterEach(() => vi.restoreAllMocks());

describe("WebSocket session location hint", () => {
  it.each([undefined, "", "wnam", "invalid"])(
    "uses the configured placement for upgrades (%s)",
    async (value) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const id = { toString: () => "object-id" } as DurableObjectId;
      const response = new Response(null, { status: 204 });
      const fetch = vi.fn().mockResolvedValue(response);
      const get = vi.fn(() => ({ fetch }));
      const idFromName = vi.fn(() => id);
      const first = vi.fn().mockResolvedValue({ ok: 1 });
      const bind = vi.fn(() => ({ first }));
      const bindings = {
        DB: { prepare: vi.fn(() => ({ bind })) },
        SESSION: { idFromName, get },
        SESSION_DO_LOCATION_HINT: value,
      } as unknown as WorkerBindings;
      const request = new Request("https://worker.test/sessions/session-id/ws", {
        headers: { Upgrade: "websocket" },
      });

      expect(await worker.fetch(request, bindings, {} as ExecutionContext)).toBe(response);
      expect(bind).toHaveBeenCalledExactlyOnceWith("session-id");
      expect(idFromName).toHaveBeenCalledExactlyOnceWith("session-id");
      if (value === "wnam") {
        expect(get).toHaveBeenCalledExactlyOnceWith(id, { locationHint: "wnam" });
      } else {
        expect(get).toHaveBeenCalledExactlyOnceWith(id);
      }
      expect(fetch).toHaveBeenCalledExactlyOnceWith(request);
      expect(warn).toHaveBeenCalledTimes(value === "invalid" ? 1 : 0);
    }
  );
});

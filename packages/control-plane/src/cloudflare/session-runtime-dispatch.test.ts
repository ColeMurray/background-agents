import { afterEach, describe, expect, it, vi } from "vitest";
import { createCloudflareEnv, type WorkerBindings } from "./platform";
import {
  createDurableObjectSessionRuntimeDispatch,
  parseSessionDoLocationHint,
} from "./session-runtime-dispatch";

afterEach(() => vi.restoreAllMocks());

function sessionNamespace() {
  const id = { toString: () => "object-id" } as DurableObjectId;
  const response = new Response(null, { status: 204 });
  const fetch = vi.fn().mockResolvedValue(response);
  const get = vi.fn(() => ({ fetch }));
  const idFromName = vi.fn(() => id);
  return {
    namespace: { get, idFromName } as unknown as DurableObjectNamespace,
    id,
    get,
    idFromName,
    fetch,
    response,
  };
}

describe("Durable Object session dispatch", () => {
  it("omits get options when no location hint is configured", async () => {
    const stub = sessionNamespace();
    const dispatch = createDurableObjectSessionRuntimeDispatch(stub.namespace);
    const request = new Request("https://session.test/internal/state");

    expect(await dispatch("session-id", request)).toBe(stub.response);
    expect(stub.idFromName).toHaveBeenCalledExactlyOnceWith("session-id");
    expect(stub.get).toHaveBeenCalledExactlyOnceWith(stub.id);
    expect(stub.fetch).toHaveBeenCalledExactlyOnceWith(request);
  });

  it("passes a configured location hint on every dispatch", async () => {
    const stub = sessionNamespace();
    const dispatch = createDurableObjectSessionRuntimeDispatch(stub.namespace, {
      locationHint: "wnam",
    });
    const request = new Request("https://session.test/internal/state");

    await dispatch("session-id", request);
    await dispatch("another-session-id", request);

    expect(stub.get.mock.calls).toEqual([
      [stub.id, { locationHint: "wnam" }],
      [stub.id, { locationHint: "wnam" }],
    ]);
  });
});

describe("session Durable Object location hint parser", () => {
  it.each([undefined, ""])("ignores an unset hint (%s) without warning", (value) => {
    const log = { warn: vi.fn() };
    expect(parseSessionDoLocationHint(value, log)).toBeUndefined();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it.each(["wnam", "enam", "sam", "weur", "eeur", "apac", "oc", "afr", "me"])(
    "accepts %s",
    (value) => {
      const log = { warn: vi.fn() };
      expect(parseSessionDoLocationHint(value, log)).toBe(value);
      expect(log.warn).not.toHaveBeenCalled();
    }
  );

  it.each(["unknown", "WNAM", " wnam "])("ignores %s with one warning", (value) => {
    const log = { warn: vi.fn() };
    expect(parseSessionDoLocationHint(value, log)).toBeUndefined();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});

describe("Cloudflare environment location hint wiring", () => {
  it.each([undefined, "", "wnam", "invalid"])(
    "parses %s once when composing the environment",
    async (value) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const stub = sessionNamespace();
      const env = createCloudflareEnv({
        SESSION: stub.namespace,
        SESSION_DO_LOCATION_HINT: value,
      } as WorkerBindings);
      const request = new Request("https://session.test/internal/state");

      await env.SESSION("session-id", request);
      await env.SESSION("another-session-id", request);

      const args = value === "wnam" ? [stub.id, { locationHint: value }] : [stub.id];
      expect(stub.get.mock.calls).toEqual([args, args]);
      expect(warn).toHaveBeenCalledTimes(value === "invalid" ? 1 : 0);
    }
  );
});

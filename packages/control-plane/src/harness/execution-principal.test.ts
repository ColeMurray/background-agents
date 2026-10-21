import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EMERGENCY_POLICY_LOOKUP_TIMEOUT_MS,
  fetchExecutionPrincipal,
} from "../harness/execution-principal";

const authority = {
  snapshot: { scratchWorkspace: "enabled" },
  current: { scratchWorkspace: "off" },
};

function hangingFetcher(onAbort?: (reason: unknown) => void) {
  return {
    fetch: vi.fn(
      (request: Request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener(
            "abort",
            () => {
              onAbort?.(request.signal.reason);
              reject(request.signal.reason);
            },
            { once: true }
          );
        })
    ),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the execution principal", () => {
  it("parses the SessionDO creation snapshot and current emergency policy", async () => {
    const fetcher = { fetch: vi.fn(async () => Response.json(authority)) };

    await expect(fetchExecutionPrincipal(fetcher)).resolves.toEqual(authority);
  });

  it("combines the tool abort signal with the lookup request", async () => {
    const abort = new AbortController();
    const observed = vi.fn();
    const pending = fetchExecutionPrincipal(hangingFetcher(observed), abort.signal);

    abort.abort(new DOMException("tool stopped", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(observed).toHaveBeenCalledOnce();
  });

  it("times out a hung cross-DO lookup instead of blocking cancellation", async () => {
    vi.useFakeTimers();
    const observed = vi.fn();
    const pending = fetchExecutionPrincipal(hangingFetcher(observed));
    const rejected = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });

    await vi.advanceTimersByTimeAsync(EMERGENCY_POLICY_LOOKUP_TIMEOUT_MS);

    await rejected;
    expect(observed).toHaveBeenCalledOnce();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { createPiFeatureCapabilitySnapshot } from "@open-inspect/shared/pi-feature-capabilities";
import {
  PI_EMERGENCY_POLICY_LOOKUP_TIMEOUT_MS,
  fetchPiCapabilityAuthority,
} from "./capability-authority-client";

const authority = {
  snapshot: createPiFeatureCapabilitySnapshot({ workspace: "enabled" }),
  current: createPiFeatureCapabilitySnapshot({ workspace: "off" }),
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

describe("Pi capability authority client", () => {
  it("parses the SessionDO creation snapshot and current emergency policy", async () => {
    const fetcher = { fetch: vi.fn(async () => Response.json(authority)) };

    await expect(fetchPiCapabilityAuthority(fetcher)).resolves.toEqual(authority);
  });

  it("combines the tool abort signal with the lookup request", async () => {
    const abort = new AbortController();
    const observed = vi.fn();
    const pending = fetchPiCapabilityAuthority(hangingFetcher(observed), abort.signal);

    abort.abort(new DOMException("tool stopped", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(observed).toHaveBeenCalledOnce();
  });

  it("times out a hung cross-DO lookup instead of blocking cancellation", async () => {
    vi.useFakeTimers();
    const observed = vi.fn();
    const pending = fetchPiCapabilityAuthority(hangingFetcher(observed));
    const rejected = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });

    await vi.advanceTimersByTimeAsync(PI_EMERGENCY_POLICY_LOOKUP_TIMEOUT_MS);

    await rejected;
    expect(observed).toHaveBeenCalledOnce();
  });
});

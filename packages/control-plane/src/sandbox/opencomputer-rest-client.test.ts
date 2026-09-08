import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenComputerRestClient } from "./opencomputer-rest-client";

const config = {
  apiUrl: "https://api.opencomputer.dev",
  apiKey: "test-key",
  template: "openinspect-runtime-abc",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// OpenComputer launches the runtime via `exec`, whose shell does NOT inherit the
// image's baked env. SANDBOX_VERSION therefore has to be re-exported in the exec
// command — otherwise the runtime reports an empty version and the image-build
// build-complete callback is rejected by the runtime-version floor check.
describe("OpenComputerRestClient runtime SANDBOX_VERSION export", () => {
  it("startRuntime exports SANDBOX_VERSION to the exec shell", async () => {
    const client = new OpenComputerRestClient(config);
    fetchSpy.mockResolvedValue(jsonResponse({ exitCode: 0, stdout: "123", stderr: "" }));

    await client.startRuntime("sb-1");

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain("/sandboxes/sb-1/exec/run");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.args[1]).toContain("SANDBOX_VERSION=v54-opencode-1-17-18");
  });

  it("runRuntimeForeground (image build path) exports SANDBOX_VERSION", async () => {
    const client = new OpenComputerRestClient(config);
    fetchSpy.mockResolvedValue(jsonResponse({ exitCode: 0, stdout: "", stderr: "" }));

    await client.runRuntimeForeground("sb-1", 60);

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(body.args[1]).toContain("SANDBOX_VERSION=v54-opencode-1-17-18");
  });
});

// A hung OpenComputer API call must fail fast with an attributed, greppable
// timeout error instead of wedging fire-and-forget callers (e.g. the
// image-build trigger under ctx.waitUntil). The message must contain "timeout"
// so SandboxProviderError classifies it transient (isTransientNetworkError),
// not permanent — otherwise provider instability trips the circuit breaker.
describe("OpenComputerRestClient request timeouts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function abortError(): DOMException {
    return new DOMException("This operation was aborted", "AbortError");
  }

  // Mirrors real fetch: never settles until the abort signal fires, then
  // rejects with an AbortError.
  function stubHangingFetch(): void {
    fetchSpy.mockImplementation(
      (_url: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(abortError()));
        })
    );
  }

  it("aborts a hung createSandbox call and rejects with an attributed timeout", async () => {
    const client = new OpenComputerRestClient(config);
    stubHangingFetch();

    const promise = client.createSandbox({ name: "build-env-1", template: config.template });
    const assertion = expect(promise).rejects.toThrow(
      "OpenComputer request timeout after 90000ms (POST /sandboxes)"
    );
    await vi.advanceTimersByTimeAsync(90_000);
    await assertion;
  });

  it("attributes a timeout that fires while reading the response body", async () => {
    const client = new OpenComputerRestClient(config);
    fetchSpy.mockImplementation((_url: unknown, init?: RequestInit) => {
      const stalledBody = new ReadableStream<Uint8Array>({
        start(streamController) {
          init?.signal?.addEventListener("abort", () => streamController.error(abortError()));
        },
      });
      return Promise.resolve(
        new Response(stalledBody, { status: 200, headers: { "content-type": "application/json" } })
      );
    });

    const promise = client.getSandbox("sb-1");
    const assertion = expect(promise).rejects.toThrow(
      "OpenComputer request timeout after 15000ms (GET /sandboxes/sb-1)"
    );
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
  });

  it("leaves fast responses unaffected and does not leak the timer", async () => {
    const client = new OpenComputerRestClient(config);
    fetchSpy.mockResolvedValue(jsonResponse({ id: "sb-1" }));

    const sandbox = await client.getSandbox("sb-1");

    expect(sandbox.id).toBe("sb-1");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rethrows API errors unchanged and clears the timer", async () => {
    const client = new OpenComputerRestClient(config);
    fetchSpy.mockResolvedValue(new Response("boom", { status: 500 }));

    await expect(client.getSandbox("sb-1")).rejects.toMatchObject({
      name: "OpenComputerApiError",
      status: 500,
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});

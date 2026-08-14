import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  OpenComputerRestClient,
  openComputerCheckpointResponseSchema,
  openComputerExecResultSchema,
  openComputerSandboxApiResponseSchema,
  openComputerSecretStoreResponseSchema,
} from "./opencomputer-rest-client";

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
    expect(body.args[1]).toContain("SANDBOX_VERSION=v59-vnc-opencode-1-18-18");
  });

  it("runRuntimeForeground (image build path) exports SANDBOX_VERSION", async () => {
    const client = new OpenComputerRestClient(config);
    fetchSpy.mockResolvedValue(jsonResponse({ exitCode: 0, stdout: "", stderr: "" }));

    await client.runRuntimeForeground("sb-1", 60);

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(body.args[1]).toContain("SANDBOX_VERSION=v59-vnc-opencode-1-18-18");
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

describe("OpenComputerRestClient response validation", () => {
  it("accepts sandboxID as the upstream sandbox identifier", async () => {
    const client = new OpenComputerRestClient(config);
    fetchSpy.mockResolvedValue(jsonResponse({ sandboxID: "sb-1", status: "running" }));

    const sandbox = await client.getSandbox("sb-1");

    expect(sandbox).toEqual({ sandboxID: "sb-1", status: "running", id: "sb-1" });
  });

  it("rejects malformed sandbox response bodies", async () => {
    const client = new OpenComputerRestClient(config);
    fetchSpy.mockResolvedValue(jsonResponse({ status: "running" }));

    await expect(client.getSandbox("sb-1")).rejects.toMatchObject({
      name: "OpenComputerApiError",
      message: "Invalid OpenComputer API response",
    });
  });

  it("accepts hostname-only tunnel responses and derives the URL", async () => {
    const client = new OpenComputerRestClient(config);
    fetchSpy.mockResolvedValue(jsonResponse({ hostname: "preview.example.test" }));

    const tunnel = await client.getTunnelUrl("sb-1", 3000);

    expect(tunnel).toEqual({
      hostname: "preview.example.test",
      url: "https://preview.example.test",
    });
  });

  // A tunnel with neither address is not a tunnel. Normalizing it to url: ""
  // would hand code-server/VNC a blank address as if validation had passed.
  it("rejects tunnel responses that carry no usable address", async () => {
    const client = new OpenComputerRestClient(config);
    fetchSpy.mockResolvedValue(jsonResponse({}));

    await expect(client.getTunnelUrl("sb-1", 3000)).rejects.toMatchObject({
      name: "OpenComputerApiError",
      message: "Invalid OpenComputer API response",
    });
  });

  it("rejects tunnel responses whose url and hostname are blank", async () => {
    const client = new OpenComputerRestClient(config);
    fetchSpy.mockResolvedValue(jsonResponse({ url: "", hostname: "   " }));

    await expect(client.getTunnelUrl("sb-1", 3000)).rejects.toMatchObject({
      name: "OpenComputerApiError",
    });
  });

  it("rejects a success with no body where a value is required", async () => {
    const client = new OpenComputerRestClient(config);
    fetchSpy.mockResolvedValue(new Response(null, { status: 200 }));

    await expect(client.getSandbox("sb-1")).rejects.toMatchObject({
      name: "OpenComputerApiError",
      message: "Invalid OpenComputer API response",
    });
  });

  it("reports invalid JSON as an API error rather than a parser error", async () => {
    const client = new OpenComputerRestClient(config);
    fetchSpy.mockResolvedValue(
      new Response('{"id": ', { status: 200, headers: { "content-type": "application/json" } })
    );

    await expect(client.getSandbox("sb-1")).rejects.toMatchObject({
      name: "OpenComputerApiError",
      message: "Invalid OpenComputer API response",
    });
  });

  it("parses a JSON body that arrives without a JSON content type", async () => {
    const client = new OpenComputerRestClient(config);
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ id: "sb-1" }), { status: 200 }));

    await expect(client.getSandbox("sb-1")).resolves.toEqual({ id: "sb-1" });
  });

  it("commands ignore whatever a success body contains", async () => {
    const client = new OpenComputerRestClient(config);
    fetchSpy.mockResolvedValue(jsonResponse({ unexpected: "payload" }));

    await expect(client.hibernateSandbox("sb-1")).resolves.toBeUndefined();

    fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(client.setSandboxTimeout("sb-1", 900)).resolves.toBeUndefined();
  });
});

// Wake is the one endpoint whose success body is optional: OpenComputer either
// returns the woken sandbox or answers empty, and the caller keeps the sandbox
// it already read. A body that is present still has to describe a sandbox.
describe("OpenComputerRestClient wake responses", () => {
  it("returns the woken sandbox when one is sent", async () => {
    const client = new OpenComputerRestClient(config);
    fetchSpy.mockResolvedValue(jsonResponse({ sandboxID: "sb-1", state: "running" }));

    await expect(client.wakeSandbox("sb-1")).resolves.toEqual({
      sandboxID: "sb-1",
      state: "running",
      id: "sb-1",
    });
  });

  it("treats an empty success as no sandbox rather than an error", async () => {
    const client = new OpenComputerRestClient(config);
    fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(client.wakeSandbox("sb-1")).resolves.toBeUndefined();
  });

  it("rejects a wake body that does not describe a sandbox", async () => {
    const client = new OpenComputerRestClient(config);
    fetchSpy.mockResolvedValue(jsonResponse({ state: "running" }));

    await expect(client.wakeSandbox("sb-1")).rejects.toMatchObject({
      name: "OpenComputerApiError",
      message: "Invalid OpenComputer API response",
    });
  });
});

describe("OpenComputer response schemas", () => {
  it("parses valid consumed response shapes", () => {
    expect(openComputerSandboxApiResponseSchema.safeParse({ id: "sb-1" }).success).toBe(true);
    expect(
      openComputerSecretStoreResponseSchema.safeParse({
        id: "store-1",
        name: "session-secrets",
        egressAllowlist: ["api.github.com"],
      }).success
    ).toBe(true);
    expect(
      openComputerExecResultSchema.safeParse({ exitCode: 0, stdout: "ok", stderr: "" }).success
    ).toBe(true);
    expect(
      openComputerCheckpointResponseSchema.safeParse({ id: "cp-1", sandboxId: "sb-1" }).success
    ).toBe(true);
  });

  it("rejects malformed or partial response shapes", () => {
    expect(openComputerSandboxApiResponseSchema.safeParse({ status: "running" }).success).toBe(
      false
    );
    expect(openComputerSecretStoreResponseSchema.safeParse({ id: "store-1" }).success).toBe(false);
    expect(openComputerExecResultSchema.safeParse({ exitCode: 0, stdout: "ok" }).success).toBe(
      false
    );
    expect(openComputerCheckpointResponseSchema.safeParse({ id: "cp-1" }).success).toBe(false);
  });

  it("accepts optional boundary fields when absent", () => {
    expect(openComputerSandboxApiResponseSchema.safeParse({ sandboxID: "sb-1" }).success).toBe(
      true
    );
    expect(
      openComputerSecretStoreResponseSchema.safeParse({ id: "store-1", name: "s" }).success
    ).toBe(true);
  });
});

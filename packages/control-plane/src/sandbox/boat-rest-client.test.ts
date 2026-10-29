import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BoatApiError,
  BoatCancelledError,
  BoatConflictError,
  BoatNotFoundError,
  BoatRestClient,
  delayUnlessCancelled,
  type BoatRestConfig,
} from "./boat-rest-client";
import { RequestDeadlineError } from "./request-deadline";

const defaultConfig: BoatRestConfig = {
  apiUrl: "https://boat.dev/api/v1",
  apiKey: "boat_test_key",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sandboxBody(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    type: "sandbox.info",
    sandbox: {
      id: "bx_abcdefgh",
      name: "openinspect-test",
      state: "ready",
      type: "small",
      archiveAfter: "2030-01-02T03:04:05.000Z",
      ttlSeconds: 7200,
      snapshotAvailable: false,
      hydrated: true,
      stop: null,
      desktopAvailable: true,
      ...overrides,
    },
  };
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function lastRequest(): { url: string; init: RequestInit & { headers: Record<string, string> } } {
  const [url, init] = fetchSpy.mock.calls.at(-1)!;
  return { url: String(url), init };
}

describe("BoatRestClient", () => {
  it("validates config and refuses to send the key in clear text", () => {
    expect(() => new BoatRestClient({ ...defaultConfig, apiUrl: "" })).toThrow("apiUrl");
    expect(() => new BoatRestClient({ ...defaultConfig, apiKey: "" })).toThrow("apiKey");
    expect(() => new BoatRestClient({ ...defaultConfig, apiUrl: "http://boat.dev/api" })).toThrow(
      "https"
    );
    expect(() => new BoatRestClient({ ...defaultConfig, apiUrl: "not a url" })).toThrow(
      "valid apiUrl"
    );
    expect(
      () => new BoatRestClient({ ...defaultConfig, apiUrl: "http://localhost:8788" })
    ).not.toThrow();
  });

  it("sends a bearer token, the org header when configured, and strips trailing slashes", async () => {
    const client = new BoatRestClient({
      ...defaultConfig,
      apiUrl: "https://boat.dev/api/v1//",
      org: "team_1",
    });
    fetchSpy.mockResolvedValue(jsonResponse(sandboxBody()));
    const sandbox = await client.getSandbox("bx_abcdefgh");
    expect(sandbox.id).toBe("bx_abcdefgh");
    const { url, init } = lastRequest();
    expect(url).toBe("https://boat.dev/api/v1/sandboxes/bx_abcdefgh");
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe("Bearer boat_test_key");
    expect(init.headers["X-Boat-Org"]).toBe("team_1");
    expect(init.headers["Content-Type"]).toBeUndefined();
  });

  it("createSandbox posts a no-env deploy from the saved snapshot under an idempotency key", async () => {
    const client = new BoatRestClient(defaultConfig);
    fetchSpy.mockResolvedValue(jsonResponse(sandboxBody({ state: "provisioning" }), 202));
    const { sandbox, hostedPorts } = await client.createSandbox({
      type: "default",
      ttlSeconds: 7200,
      env: { SANDBOX_ID: "sandbox-logical" },
      from: "open-inspect-abc",
      idempotencyKey: "openinspect-key",
      monitoring: false,
    });
    expect(sandbox.state).toBe("provisioning");
    expect(hostedPorts).toEqual([]);
    const { url, init } = lastRequest();
    expect(url).toBe("https://boat.dev/api/v1/sandboxes");
    expect(init.headers["Idempotency-Key"]).toBe("openinspect-key");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({
      type: "default",
      ttlSeconds: 7200,
      env: { SANDBOX_ID: "sandbox-logical" },
      from: "open-inspect-abc",
      noEnv: true,
      snapshots: true,
      monitoring: false,
    });
  });

  it("createSandbox forwards the setup script when given", async () => {
    const client = new BoatRestClient(defaultConfig);
    fetchSpy.mockResolvedValue(jsonResponse(sandboxBody({ state: "provisioning" }), 202));
    await client.createSandbox({
      type: "default",
      ttlSeconds: 7200,
      env: {},
      from: "open-inspect-abc",
      idempotencyKey: "openinspect-key",
      monitoring: false,
      setupScript: "#!/bin/bash\nexec /home/user/openinspect/launcher.sh\n",
    });
    expect(JSON.parse(String(lastRequest().init.body))).toMatchObject({
      setupScript: "#!/bin/bash\nexec /home/user/openinspect/launcher.sh\n",
    });
  });

  it("createSandbox names, privatizes and routes in the same request and returns the routes", async () => {
    const client = new BoatRestClient(defaultConfig);
    fetchSpy.mockResolvedValue(
      jsonResponse(
        {
          ...sandboxBody({ state: "provisioned", visibility: "private" }),
          type: "sandbox.created",
          status: "provisioning",
          hostedPorts: [
            {
              port: 8080,
              url: "https://sub-8080.on.boat.dev",
              isProtected: false,
              access: "public",
              localhost: false,
            },
            { port: 3000, error: "host_failed", message: "route not ready" },
          ],
        },
        202
      )
    );
    const created = await client.createSandbox({
      type: "default",
      ttlSeconds: 7200,
      env: {},
      from: "open-inspect-abc",
      idempotencyKey: "openinspect-key",
      monitoring: false,
      name: "openinspect-test-sandbox-logical",
      visibility: "private",
      hostedPorts: [
        { port: 8080, public: true, title: "code-server" },
        { port: 3000, public: false },
      ],
    });
    expect(JSON.parse(String(lastRequest().init.body))).toMatchObject({
      name: "openinspect-test-sandbox-logical",
      visibility: "private",
      hostedPorts: [
        { port: 8080, public: true, title: "code-server" },
        { port: 3000, public: false },
      ],
    });
    expect(created.sandbox.visibility).toBe("private");
    // A port the create could not host comes back with its error, not a URL.
    expect(created.hostedPorts).toEqual([
      { port: 8080, url: "https://sub-8080.on.boat.dev", isProtected: false, access: "public" },
      { port: 3000, error: "host_failed", message: "route not ready" },
    ]);
  });

  it("scrubs create env values out of a provider error", async () => {
    const client = new BoatRestClient(defaultConfig);
    fetchSpy.mockResolvedValue(
      jsonResponse(
        {
          ok: false,
          type: "sandbox.error",
          status: 400,
          code: "invalid_env",
          message: 'Value "hunter2-secret" is not allowed',
          requestId: "req_1",
        },
        400
      )
    );
    const error = await client
      .createSandbox({
        type: "small",
        ttlSeconds: 60,
        env: { DB_PASSWORD: "hunter2-secret" },
        from: "snap",
        idempotencyKey: "k",
        monitoring: false,
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BoatApiError);
    const apiError = error as BoatApiError;
    expect(apiError.status).toBe(400);
    expect(apiError.code).toBe("invalid_env");
    expect(apiError.requestId).toBe("req_1");
    expect(apiError.message).not.toContain("hunter2-secret");
    expect(apiError.message).toContain("[redacted]");
  });

  it("redacts an echoed secret that straddles the message cutoff", async () => {
    const client = new BoatRestClient(defaultConfig);
    const secret = `tok-"q"-${"s".repeat(40)}`;
    const padding = "p".repeat(280);
    for (const echoed of [secret, JSON.stringify(secret).slice(1, -1)]) {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse(
          {
            ok: false,
            type: "sandbox.error",
            status: 400,
            code: "invalid_env",
            message: `${padding}${echoed} is not allowed`,
          },
          400
        )
      );
      const error = await client
        .createSandbox({
          type: "small",
          ttlSeconds: 60,
          env: { API_TOKEN: secret },
          from: "snap",
          idempotencyKey: "k",
          monitoring: false,
        })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BoatApiError);
      const message = (error as BoatApiError).message;
      expect(message).not.toContain("tok-");
      expect(message).toContain("[redacted]");
      expect(message.length).toBeLessThan(400);
    }
  });

  it("maps 404 and 409 to typed errors that keep the Boat code", async () => {
    const client = new BoatRestClient(defaultConfig);
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ ok: false, status: 404, code: "sandbox_not_found", message: "gone" }, 404)
    );
    await expect(client.getSandbox("bx_missing")).rejects.toBeInstanceOf(BoatNotFoundError);

    fetchSpy.mockResolvedValueOnce(
      jsonResponse(
        { ok: false, status: 409, code: "snapshot_data_expired", message: "expired" },
        409
      )
    );
    const conflict = await client
      .resumeSandbox("bx_abcdefgh", { ttlSeconds: 60 })
      .catch((e: unknown) => e);
    expect(conflict).toBeInstanceOf(BoatConflictError);
    expect((conflict as BoatConflictError).code).toBe("snapshot_data_expired");
    expect((conflict as BoatConflictError).message).toContain("POST /sandboxes/bx_abcdefgh/resume");
  });

  it("describes a non-JSON failure by status alone", async () => {
    const client = new BoatRestClient(defaultConfig);
    fetchSpy.mockResolvedValue(
      new Response("<html>bad gateway</html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      })
    );
    const error = await client.getSandbox("bx_abcdefgh").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BoatApiError);
    expect((error as BoatApiError).status).toBe(502);
    expect((error as BoatApiError).message).not.toContain("<html>");
  });

  it("rejects a success body that does not match the schema", async () => {
    const client = new BoatRestClient(defaultConfig);
    fetchSpy.mockResolvedValue(jsonResponse({ ok: true, sandbox: { state: "ready" } }));
    const error = await client.getSandbox("bx_abcdefgh").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BoatApiError);
    expect((error as BoatApiError).code).toBe("invalid_response");
  });

  it("updateSandbox sends only the fields it is given", async () => {
    const client = new BoatRestClient(defaultConfig);
    fetchSpy.mockImplementation(() => Promise.resolve(jsonResponse(sandboxBody())));
    await client.updateSandbox("bx_abcdefgh", { name: "openinspect-test-sb" });
    expect(lastRequest().init.method).toBe("PATCH");
    expect(JSON.parse(String(lastRequest().init.body))).toEqual({ name: "openinspect-test-sb" });
    await client.updateSandbox("bx_abcdefgh", { ttlSeconds: 60 });
    expect(JSON.parse(String(lastRequest().init.body))).toEqual({ ttlSeconds: 60 });
  });

  it("unshare posts to the sandbox and returns its new visibility", async () => {
    const client = new BoatRestClient(defaultConfig);
    fetchSpy.mockResolvedValue(jsonResponse(sandboxBody({ visibility: "private" })));
    const sandbox = await client.unshareSandbox("bx_abcdefgh");
    expect(sandbox.visibility).toBe("private");
    const { url, init } = lastRequest();
    expect(url).toBe("https://boat.dev/api/v1/sandboxes/bx_abcdefgh/unshare");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
  });

  it("stop is never forced and returns the action's sandbox", async () => {
    const client = new BoatRestClient(defaultConfig);
    fetchSpy.mockResolvedValue(
      jsonResponse(
        {
          ok: true,
          type: "sandbox.stopping",
          id: "bx_abcdefgh",
          status: "archiving",
          sandbox: sandboxBody({ state: "archiving" }).sandbox,
        },
        202
      )
    );
    const sandbox = await client.stopSandbox("bx_abcdefgh");
    expect(sandbox?.state).toBe("archiving");
    const { url, init } = lastRequest();
    expect(url).toBe("https://boat.dev/api/v1/sandboxes/bx_abcdefgh/stop");
    expect(JSON.parse(String(init.body))).toEqual({ force: false });
  });

  it("delete repeats the id in the confirmation header", async () => {
    const client = new BoatRestClient(defaultConfig);
    fetchSpy.mockResolvedValue(
      jsonResponse({ ok: true, type: "sandbox.deleting", operation: { id: "bdop_1" } }, 202)
    );
    await client.deleteSandbox("bx_abcdefgh");
    const { url, init } = lastRequest();
    expect(url).toBe("https://boat.dev/api/v1/sandboxes/bx_abcdefgh");
    expect(init.method).toBe("DELETE");
    expect(init.headers["X-Ascii-Confirm-Delete"]).toBe("bx_abcdefgh");
  });

  it("starts detached commands and reads their status with a capped tail", async () => {
    const client = new BoatRestClient(defaultConfig);
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ ok: true, type: "command.started", success: true, processId: 4242, pid: 4242 })
    );
    const started = await client.startDetachedCommand(
      "bx_abcdefgh",
      "/home/user/openinspect/launcher.sh"
    );
    expect(started).toEqual({ processId: 4242 });
    expect(JSON.parse(String(lastRequest().init.body))).toEqual({
      command: "/home/user/openinspect/launcher.sh",
      detached: true,
    });

    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        type: "command.status",
        status: "exited",
        known: true,
        running: false,
        exitCode: 75,
        stdout: "",
        stderr: "already running",
      })
    );
    const status = await client.getCommandStatus("bx_abcdefgh", 4242);
    expect(status).toMatchObject({ status: "exited", exitCode: 75, stderr: "already running" });
    expect(lastRequest().url).toBe(
      "https://boat.dev/api/v1/sandboxes/bx_abcdefgh/commands/4242?tailBytes=4096"
    );
  });

  it("runs synchronous commands under their own timeout", async () => {
    const client = new BoatRestClient(defaultConfig);
    fetchSpy.mockResolvedValue(
      jsonResponse({
        ok: true,
        type: "command.finished",
        success: true,
        exitCode: 0,
        stdout: "ok\n",
        stderr: "",
        timedOut: false,
      })
    );
    const result = await client.runCommand("bx_abcdefgh", "true", { timeoutSeconds: 30 });
    expect(result).toEqual({ exitCode: 0, stdout: "ok\n", stderr: "", timedOut: false });
    expect(JSON.parse(String(lastRequest().init.body))).toEqual({
      command: "true",
      timeoutSeconds: 30,
    });
  });

  it("writes UTF-8 files and hosts ports", async () => {
    const client = new BoatRestClient(defaultConfig);
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        type: "file.written",
        success: true,
        path: "x",
        encoding: "utf8",
        size: 3,
      })
    );
    await client.writeFile("bx_abcdefgh", {
      path: "/home/user/workspace/.tunnels.env",
      content: "a=b",
    });
    expect(JSON.parse(String(lastRequest().init.body))).toEqual({
      path: "/home/user/workspace/.tunnels.env",
      content: "a=b",
      encoding: "utf8",
    });

    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        type: "port.hosted",
        success: true,
        port: 3000,
        url: "https://sub-3000.on.boat.dev?_token=abc",
        isProtected: true,
        access: "private",
      })
    );
    const hosted = await client.hostPort("bx_abcdefgh", {
      port: 3000,
      public: false,
      title: "tunnel 3000",
    });
    expect(hosted.url).toBe("https://sub-3000.on.boat.dev?_token=abc");
    expect(JSON.parse(String(lastRequest().init.body))).toEqual({
      port: 3000,
      public: false,
      title: "tunnel 3000",
    });
  });

  it("saves, reads and deletes saved snapshots", async () => {
    const client = new BoatRestClient(defaultConfig);
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(
        {
          ok: true,
          type: "snapshot.saved.saving",
          status: "saving",
          snapshot: {
            name: "oi-img-x",
            status: "saving",
            sourceSandboxId: "bx_abcdefgh",
            createdAt: "2030-01-01T00:00:00.000Z",
          },
        },
        202
      )
    );
    const saving = await client.saveSavedSnapshot("bx_abcdefgh", "oi-img-x");
    expect(saving).toMatchObject({
      name: "oi-img-x",
      status: "saving",
      sourceSandboxId: "bx_abcdefgh",
    });
    let { url, init } = lastRequest();
    expect(url).toBe("https://boat.dev/api/v1/saved-snapshots");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ sandboxId: "bx_abcdefgh", name: "oi-img-x" });

    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        type: "snapshot.saved.info",
        snapshot: {
          name: "oi-img-x",
          status: "ready",
          sourceSandboxId: "bx_abcdefgh",
          snapshotId: "5338c9a2",
          type: "small",
          sizeBytes: 3907112960,
          createdAt: "2030-01-01T00:00:00.000Z",
        },
      })
    );
    const ready = await client.getSavedSnapshot("oi-img-x");
    expect(ready).toMatchObject({ status: "ready", type: "small", sizeBytes: 3907112960 });
    ({ url, init } = lastRequest());
    expect(url).toBe("https://boat.dev/api/v1/saved-snapshots/oi-img-x");
    expect(init.method).toBe("GET");

    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ ok: false, status: 404, code: "not_found", message: "not_found" }, 404)
    );
    await expect(client.getSavedSnapshot("oi-img-gone")).rejects.toBeInstanceOf(BoatNotFoundError);

    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        type: "snapshot.saved.deleted",
        name: "oi-img-x",
        status: "deleted",
      })
    );
    await client.deleteSavedSnapshot("oi-img-x");
    ({ url, init } = lastRequest());
    expect(url).toBe("https://boat.dev/api/v1/saved-snapshots/oi-img-x");
    expect(init.method).toBe("DELETE");
  });

  it.each([
    [402, "credit_required", BoatApiError],
    [409, "save_in_progress", BoatConflictError],
  ] as const)(
    "preserves HTTP %i and %s on a refused snapshot save",
    async (status, code, errorType) => {
      const client = new BoatRestClient(defaultConfig);
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({ ok: false, status, code, message: code, requestId: "req_save" }, status)
      );

      const error = await client
        .saveSavedSnapshot("bx_abcdefgh", "oi-img-x")
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(errorType);
      expect(error).toMatchObject({ status, code, requestId: "req_save" });
      expect(lastRequest().url).toBe("https://boat.dev/api/v1/saved-snapshots");
    }
  );

  it("surfaces a request deadline as RequestDeadlineError", async () => {
    vi.useFakeTimers();
    try {
      const client = new BoatRestClient(defaultConfig);
      fetchSpy.mockImplementation(
        (_url: unknown, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError"))
            );
          })
      );
      const pending = client.getSandbox("bx_abcdefgh").catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await pending).toBeInstanceOf(RequestDeadlineError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces the caller's abort as BoatCancelledError", async () => {
    const client = new BoatRestClient(defaultConfig);
    const controller = new AbortController();
    fetchSpy.mockImplementation(
      (_url: unknown, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError"))
          );
        })
    );
    const pending = client.getSandbox("bx_abcdefgh", controller.signal).catch((e: unknown) => e);
    controller.abort();
    expect(await pending).toBeInstanceOf(BoatCancelledError);
  });
});

describe("delayUnlessCancelled", () => {
  it("rejects at once on an aborted signal and on abort while waiting", async () => {
    await expect(delayUnlessCancelled(10, AbortSignal.abort())).rejects.toBeInstanceOf(
      BoatCancelledError
    );
    const controller = new AbortController();
    const pending = delayUnlessCancelled(10_000, controller.signal).catch((e: unknown) => e);
    controller.abort();
    expect(await pending).toBeInstanceOf(BoatCancelledError);
  });

  it("resolves after the delay without a signal", async () => {
    await expect(delayUnlessCancelled(1)).resolves.toBeUndefined();
  });
});

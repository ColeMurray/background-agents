import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTOR_ENROLLMENT_TIMEOUT_MS, enrollLinearActor } from "./actor-enrollment";
import { createFakeKV, createLinearFetchMock, makeLinearBotEnv } from "./test-helpers";
import type { LinearApiClient } from "./utils/linear-client";

const client: LinearApiClient = {
  accessToken: "linear-token",
  organizationId: "org-1",
  renewAccessToken: async () => "linear-token",
};

describe("Linear actor enrollment", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function failureLogs() {
    return vi.mocked(console.warn).mock.calls.map(([line]) => JSON.parse(String(line)));
  }

  it("sends the author's server-fetched profile only after an email-required refusal", async () => {
    vi.stubGlobal(
      "fetch",
      createLinearFetchMock({
        graphql: ({ body }) => {
          expect(body.variables).toEqual({ id: "new-collaborator" });
          return Response.json({
            data: { user: { id: "new-collaborator", name: "Ada", email: "ada@corp.test" } },
          });
        },
      })
    );
    const env = makeLinearBotEnv(createFakeKV().kv);
    const request = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ code: "actor_email_required" }, { status: 403 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    env.CONTROL_PLANE = { fetch: request };

    expect(await enrollLinearActor(env, client, "new-collaborator", "trace-1")).toBeNull();
    expect(request).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({});
    const [url, init] = request.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("https://internal/actors/me");
    expect(new Headers(init.headers).get("X-OpenInspect-Actor")).toBe("linear:new-collaborator");
    expect(JSON.parse(String(init.body))).toEqual({ displayName: "Ada", email: "ada@corp.test" });
    expect(failureLogs()).toEqual([]);
  });

  it("admits a known actor without waiting for a stalled Linear profile lookup", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {}))
    );
    const env = makeLinearBotEnv(createFakeKV().kv);
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    env.CONTROL_PLANE = { fetch: request };

    expect(await enrollLinearActor(env, client, "known-actor", "trace-1")).toBeNull();

    expect(request).toHaveBeenCalledOnce();
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({});
    expect(fetch).not.toHaveBeenCalled();
    expect(failureLogs()).toEqual([]);
  });

  it.each([403, 503])("refuses to continue when enrollment returns %s", async (status) => {
    vi.stubGlobal("fetch", createLinearFetchMock({ graphql: () => Response.json({ data: {} }) }));
    const env = makeLinearBotEnv(createFakeKV().kv);
    env.CONTROL_PLANE = { fetch: vi.fn().mockResolvedValue(Response.json({}, { status })) };
    expect(await enrollLinearActor(env, client, "new-collaborator", "trace-1")).toContain(
      "Cannot verify"
    );
    expect(failureLogs()).toEqual([
      expect.objectContaining({
        msg: "control_plane.enroll_actor",
        trace_id: "trace-1",
        actor: "linear:new-collaborator",
        http_status: status,
        outcome: "unavailable",
      }),
    ]);
  });

  it.each([
    [
      "unknown code",
      () => Response.json({ code: "unexpected_code" }, { status: 503 }),
      "unexpected_code",
    ],
    ["invalid JSON", () => new Response("not json", { status: 503 }), undefined],
    ["invalid code", () => Response.json({ code: 123 }, { status: 503 }), undefined],
  ])("logs one diagnostic for an enrollment response with %s", async (_name, response, code) => {
    vi.stubGlobal("fetch", createLinearFetchMock({ graphql: () => Response.json({ data: {} }) }));
    const env = makeLinearBotEnv(createFakeKV().kv);
    env.CONTROL_PLANE = { fetch: vi.fn().mockResolvedValue(response()) };

    expect(await enrollLinearActor(env, client, "new-collaborator", "trace-1")).toContain(
      "Cannot verify"
    );

    expect(failureLogs()).toEqual([
      expect.objectContaining({
        msg: "control_plane.enroll_actor",
        trace_id: "trace-1",
        actor: "linear:new-collaborator",
        http_status: 503,
        outcome: "unavailable",
      }),
    ]);
    expect(failureLogs()[0].error_code).toBe(code);
  });

  it("logs transport exceptions before returning guidance", async () => {
    vi.stubGlobal("fetch", createLinearFetchMock({ graphql: () => Response.json({ data: {} }) }));
    const env = makeLinearBotEnv(createFakeKV().kv);
    env.CONTROL_PLANE = {
      fetch: vi.fn().mockRejectedValue(new Error("Control plane unreachable")),
    };

    expect(await enrollLinearActor(env, client, "new-collaborator", "trace-1")).toContain(
      "Cannot verify"
    );

    expect(failureLogs()).toEqual([
      expect.objectContaining({
        msg: "control_plane.enroll_actor",
        trace_id: "trace-1",
        actor: "linear:new-collaborator",
        outcome: "unavailable",
        error_message: "Control plane unreachable",
        error_type: "Error",
      }),
    ]);
  });

  it.each(["actor_email_required", "actor_admission_denied"])(
    "logs %s before returning admission guidance",
    async (code) => {
      vi.stubGlobal("fetch", createLinearFetchMock({ graphql: () => Response.json({ data: {} }) }));
      const env = makeLinearBotEnv(createFakeKV().kv);
      env.CONTROL_PLANE = {
        fetch: vi
          .fn()
          .mockImplementation(() => Promise.resolve(Response.json({ code }, { status: 403 }))),
      };

      expect(await enrollLinearActor(env, client, "new-collaborator", "trace-1")).not.toContain(
        "Cannot verify"
      );

      expect(failureLogs()).toEqual([
        expect.objectContaining({
          msg: "control_plane.enroll_actor",
          trace_id: "trace-1",
          actor: "linear:new-collaborator",
          outcome: "denied",
          http_status: 403,
          error_code: code,
        }),
      ]);
      expect(env.CONTROL_PLANE.fetch).toHaveBeenCalledTimes(
        code === "actor_email_required" ? 2 : 1
      );
      expect(fetch).toHaveBeenCalledTimes(code === "actor_email_required" ? 1 : 0);
    }
  );

  it.each([
    "probe request",
    "probe response body",
    "profile request",
    "profile response body",
    "request",
    "response body",
  ])("fails closed when the enrollment %s stalls", async (phase) => {
    const deadline = new AbortController();
    const defaultTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((timeoutMs) =>
        timeoutMs === ACTOR_ENROLLMENT_TIMEOUT_MS ? deadline.signal : defaultTimeout(timeoutMs)
      );
    let markStalled!: () => void;
    const stalled = new Promise<void>((resolve) => {
      markStalled = resolve;
    });
    const neverCompletes = () =>
      new Promise<never>(() => {
        markStalled();
      });
    let profileSignal: AbortSignal | null | undefined;
    const profileResponse = Response.json({ data: {} });
    if (phase === "profile response body") {
      vi.spyOn(profileResponse, "json").mockImplementation(neverCompletes);
    }
    vi.stubGlobal(
      "fetch",
      createLinearFetchMock({
        graphql: ({ signal }) => {
          profileSignal = signal;
          return phase === "profile request" ? neverCompletes() : profileResponse;
        },
      })
    );
    const response = Response.json({}, { status: 403 });
    if (phase === "response body") vi.spyOn(response, "json").mockImplementation(neverCompletes);
    const probeResponse = Response.json({ code: "actor_email_required" }, { status: 403 });
    if (phase === "probe response body")
      vi.spyOn(probeResponse, "json").mockImplementation(neverCompletes);
    const request = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBe(deadline.signal);
      if (request.mock.calls.length === 1) {
        return phase === "probe request" ? neverCompletes() : probeResponse;
      }
      return phase === "request" ? neverCompletes() : response;
    });
    const env = makeLinearBotEnv(createFakeKV().kv);
    env.CONTROL_PLANE = { fetch: request };

    const enrollment = enrollLinearActor(env, client, "new-collaborator", "trace-1");
    await stalled;
    deadline.abort(new DOMException("timed out", "TimeoutError"));

    expect(await enrollment).toContain("Cannot verify");
    expect(request).toHaveBeenCalledTimes(
      phase.startsWith("profile") || phase.startsWith("probe") ? 1 : 2
    );
    if (phase.startsWith("probe")) expect(profileSignal).toBeUndefined();
    else expect(profileSignal).toMatchObject({ aborted: true });
    expect(timeoutSpy).toHaveBeenCalledWith(ACTOR_ENROLLMENT_TIMEOUT_MS);
    expect(
      timeoutSpy.mock.calls.filter(([timeoutMs]) => timeoutMs === ACTOR_ENROLLMENT_TIMEOUT_MS)
    ).toHaveLength(1);
    expect(failureLogs()).toEqual([
      expect.objectContaining({
        msg: "control_plane.enroll_actor",
        trace_id: "trace-1",
        actor: "linear:new-collaborator",
        outcome: "unavailable",
        error_message: "timed out",
      }),
    ]);
    expect(failureLogs()[0].http_status).toBe(phase === "probe request" ? undefined : 403);
  });
});

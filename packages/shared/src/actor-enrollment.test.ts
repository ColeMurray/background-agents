import { describe, expect, it, vi } from "vitest";
import { enrollActor } from "./actor-enrollment";
import { sha256Hex, verifyServiceSignature } from "./service-auth";

const secret = "enrollment-test-secret";

describe("actor enrollment protocol", () => {
  it.each(["slack-bot", "linear-bot"] as const)(
    "signs the profile, actor, and trace as %s",
    async (service) => {
      const actor = service === "slack-bot" ? "slack:U123" : "linear:user-1";
      const profile = { displayName: "Ada", email: "ada@example.com" };
      const signal = new AbortController().signal;
      const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        expect(url).toBe("https://internal/actors/me");
        expect(init?.method).toBe("POST");
        expect(init?.signal).toBe(signal);
        expect(JSON.parse(String(init?.body))).toEqual(profile);
        const headers = new Headers(init?.headers);
        expect(headers.get("X-OpenInspect-Service")).toBe(service);
        expect(headers.get("X-OpenInspect-Actor")).toBe(actor);
        expect(headers.get("x-trace-id")).toBe("trace-1");
        expect(headers.get("Content-Type")).toBe("application/json");
        expect(
          await verifyServiceSignature({
            signatureHeader: headers.get("X-OpenInspect-Service-Signature")!,
            service,
            secret,
            method: "POST",
            url: String(url),
            bodySha256Hex: await sha256Hex(String(init?.body)),
            actor,
          })
        ).toMatchObject({ ok: true });
        return new Response(null, { status: 204 });
      });

      await expect(
        enrollActor(
          service,
          { SERVICE_AUTH_SECRET: secret, CONTROL_PLANE: { fetch } },
          { actor, profile, traceId: "trace-1" },
          signal
        )
      ).resolves.toEqual({ outcome: "enrolled", httpStatus: 204 });
      expect(fetch).toHaveBeenCalledOnce();
    }
  );

  it.each([
    [403, { code: "actor_email_required" }, "email_required", "actor_email_required"],
    [403, { code: "actor_admission_denied" }, "admission_denied", "actor_admission_denied"],
    [403, { code: "actor_email_required", error: 123 }, "email_required", "actor_email_required"],
    [403, { code: "unknown" }, "unavailable", "unknown"],
    [403, { code: 123 }, "unavailable", undefined],
    [403, null, "unavailable", undefined],
    [503, { code: "actor_email_required" }, "unavailable", "actor_email_required"],
    [500, { code: "actor_admission_denied" }, "unavailable", "actor_admission_denied"],
  ] as const)("classifies HTTP %s with %j", async (status, body, outcome, errorCode) => {
    const fetch = vi.fn().mockResolvedValue(Response.json(body, { status }));
    await expect(
      enrollActor(
        "linear-bot",
        { SERVICE_AUTH_SECRET: secret, CONTROL_PLANE: { fetch } },
        { actor: "linear:user-1", profile: {} },
        new AbortController().signal
      )
    ).resolves.toEqual({ outcome, httpStatus: status, errorCode });
  });

  it("treats an unreadable refusal body as unavailable", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("not json", { status: 500 }));
    await expect(
      enrollActor(
        "slack-bot",
        { SERVICE_AUTH_SECRET: secret, CONTROL_PLANE: { fetch } },
        { actor: "slack:U123", profile: {} },
        new AbortController().signal
      )
    ).resolves.toEqual({ outcome: "unavailable", httpStatus: 500, errorCode: undefined });
  });

  it.each([new Error("offline"), "offline"])("reports transport failure %s", async (error) => {
    const fetch = vi.fn().mockRejectedValue(error);
    await expect(
      enrollActor(
        "slack-bot",
        { SERVICE_AUTH_SECRET: secret, CONTROL_PLANE: { fetch } },
        { actor: "slack:U123", profile: {} },
        new AbortController().signal
      )
    ).resolves.toEqual({
      outcome: "unavailable",
      httpStatus: undefined,
      error: new Error("offline"),
    });
  });

  it("does not send a request when the deadline already expired", async () => {
    const error = new DOMException("timed out", "TimeoutError");
    const fetch = vi.fn();
    await expect(
      enrollActor(
        "linear-bot",
        { SERVICE_AUTH_SECRET: secret, CONTROL_PLANE: { fetch } },
        { actor: "linear:user-1", profile: {} },
        AbortSignal.abort(error)
      )
    ).resolves.toMatchObject({ outcome: "unavailable", error });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["request", "response body"])("bounds a stalled %s", async (phase) => {
    const deadline = new AbortController();
    const error = new DOMException("timed out", "TimeoutError");
    let markStalled!: () => void;
    const stalled = new Promise<void>((resolve) => {
      markStalled = resolve;
    });
    const neverCompletes = () =>
      new Promise<never>(() => {
        markStalled();
      });
    const response = Response.json({ code: "actor_email_required" }, { status: 403 });
    if (phase === "response body") vi.spyOn(response, "json").mockImplementation(neverCompletes);
    const fetch = vi.fn(async () => (phase === "request" ? neverCompletes() : response));

    const enrollment = enrollActor(
      "linear-bot",
      { SERVICE_AUTH_SECRET: secret, CONTROL_PLANE: { fetch } },
      { actor: "linear:user-1", profile: {} },
      deadline.signal
    );
    await stalled;
    deadline.abort(error);

    await expect(enrollment).resolves.toEqual({
      outcome: "unavailable",
      httpStatus: phase === "request" ? undefined : 403,
      error,
    });
    expect(fetch).toHaveBeenCalledOnce();
  });
});

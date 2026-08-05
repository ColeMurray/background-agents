import { sha256Hex, verifyServiceSignature } from "@open-inspect/shared/service-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dispatchControlPlaneFetch: vi.fn(),
}));

vi.mock("./control-plane-transport", () => ({
  dispatchControlPlaneFetch: mocks.dispatchControlPlaneFetch,
  getControlPlaneUrl: () => "https://control-plane.example",
}));

import { dispatchWebServiceRequest } from "./control-plane-service";

describe("dispatchWebServiceRequest", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetAllMocks();
    process.env = {
      ...originalEnv,
      SERVICE_AUTH_SECRET: "web-service-secret",
    };
    mocks.dispatchControlPlaneFetch.mockResolvedValue(Response.json({ ok: true }));
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("dispatches the exact request with a fresh web-service signature", async () => {
    const body = new TextEncoder().encode('{"provider":"github"}');

    await dispatchWebServiceRequest({
      method: "POST",
      path: "/internal/example?mode=test",
      headers: {
        Authorization: "Bearer caller-controlled",
        "X-OpenInspect-Actor": "caller-controlled",
        "X-OpenInspect-Service": "modal",
        "X-OpenInspect-Service-Signature": "caller-controlled",
      },
      body,
      traceId: "trace-1",
      transportOptions: {
        redirect: "manual",
        cache: "no-store",
      },
    });

    const [url, init] = mocks.dispatchControlPlaneFetch.mock.calls[0] ?? [];
    expect(url).toBe("https://control-plane.example/internal/example?mode=test");
    expect(init).toMatchObject({
      method: "POST",
      redirect: "manual",
      cache: "no-store",
      body: expect.objectContaining({ byteLength: body.byteLength }),
    });

    const sentHeaders = new Headers(init?.headers);
    expect(sentHeaders.get("Authorization")).toBeNull();
    expect(sentHeaders.get("X-OpenInspect-Actor")).toBeNull();
    expect(sentHeaders.get("X-OpenInspect-Service")).toBe("web");
    expect(sentHeaders.get("X-OpenInspect-Service-Signature")).toMatch(/^sig1\./);
    expect(sentHeaders.get("X-Trace-Id")).toBe("trace-1");

    const verification = await verifyServiceSignature({
      signatureHeader: sentHeaders.get("X-OpenInspect-Service-Signature") ?? "",
      service: "web",
      secret: "web-service-secret",
      method: "POST",
      url: String(url),
      bodySha256Hex: await sha256Hex(body),
      actor: "",
    });
    expect(verification.ok).toBe(true);
  });

  it("rejects body types whose dispatched bytes cannot be signed exactly", async () => {
    await expect(
      dispatchWebServiceRequest({
        method: "POST",
        path: "/internal/example",
        body: new URLSearchParams({ provider: "github" }),
      })
    ).rejects.toThrow("Unsupported control-plane request body");
    expect(mocks.dispatchControlPlaneFetch).not.toHaveBeenCalled();
  });
});

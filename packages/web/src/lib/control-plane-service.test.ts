import { sha256Hex, verifyServiceSignature } from "@open-inspect/shared/service-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dispatchControlPlaneFetch: vi.fn(),
  getControlPlaneUrl: vi.fn(),
}));

vi.mock("./control-plane-transport", () => ({
  dispatchControlPlaneFetch: mocks.dispatchControlPlaneFetch,
  getControlPlaneUrl: mocks.getControlPlaneUrl,
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
    mocks.getControlPlaneUrl.mockReturnValue("https://control-plane.example");
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

  it("rejects a request target that is not an absolute path", async () => {
    await expect(
      dispatchWebServiceRequest({
        method: "GET",
        path: "@attacker.example/",
      })
    ).rejects.toThrow("Control-plane request path must be an absolute path");
    expect(mocks.dispatchControlPlaneFetch).not.toHaveBeenCalled();
  });

  it("rejects a protocol-relative request target", async () => {
    await expect(
      dispatchWebServiceRequest({
        method: "GET",
        path: "//control-plane.example/internal/example",
      })
    ).rejects.toThrow("Control-plane request path must start with exactly one slash");
    expect(mocks.dispatchControlPlaneFetch).not.toHaveBeenCalled();
  });

  it("rejects credentials in the configured control-plane URL", async () => {
    mocks.getControlPlaneUrl.mockReturnValue(
      "https://caller-controlled:secret@control-plane.example"
    );

    await expect(
      dispatchWebServiceRequest({
        method: "GET",
        path: "/internal/example",
      })
    ).rejects.toThrow("Control-plane URL must not include credentials");
    expect(mocks.dispatchControlPlaneFetch).not.toHaveBeenCalled();
  });

  it("rejects a backslash-based request target", async () => {
    await expect(
      dispatchWebServiceRequest({
        method: "GET",
        path: "/\\attacker.example/",
      })
    ).rejects.toThrow("Control-plane request path must not include backslashes");
    expect(mocks.dispatchControlPlaneFetch).not.toHaveBeenCalled();
  });

  it("rejects a request target with a fragment", async () => {
    await expect(
      dispatchWebServiceRequest({
        method: "GET",
        path: "/internal/example#unsigned-fragment",
      })
    ).rejects.toThrow("Control-plane request path must not include a fragment");
    expect(mocks.dispatchControlPlaneFetch).not.toHaveBeenCalled();
  });

  it("rejects an empty fragment delimiter", async () => {
    await expect(
      dispatchWebServiceRequest({
        method: "GET",
        path: "/internal/example#",
      })
    ).rejects.toThrow("Control-plane request path must not include a fragment");
    expect(mocks.dispatchControlPlaneFetch).not.toHaveBeenCalled();
  });

  it("rejects an encoded backslash in a request target", async () => {
    await expect(
      dispatchWebServiceRequest({
        method: "GET",
        path: "/%5c%5cattacker.example/",
      })
    ).rejects.toThrow("Control-plane request path must not include encoded backslashes");
    expect(mocks.dispatchControlPlaneFetch).not.toHaveBeenCalled();
  });
});

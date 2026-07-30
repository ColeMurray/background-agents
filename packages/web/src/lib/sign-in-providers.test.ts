import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dispatchWebServiceRequest: vi.fn(),
  getRequestCorrelation: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("./control-plane-service", () => ({
  dispatchWebServiceRequest: mocks.dispatchWebServiceRequest,
}));

vi.mock("./request-context", () => ({
  getRequestCorrelation: mocks.getRequestCorrelation,
}));

vi.mock("./logger", () => ({
  createLogger: () => ({ error: mocks.logError }),
}));

import { getEnabledSignInProviders } from "./sign-in-providers";

describe("getEnabledSignInProviders", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getRequestCorrelation.mockResolvedValue({
      traceId: "trace-1",
      requestId: "request-1",
    });
  });

  it("returns the validated provider set from an exact server-only request", async () => {
    mocks.dispatchWebServiceRequest.mockResolvedValue(
      Response.json({ providers: ["github", "google"] })
    );

    await expect(getEnabledSignInProviders()).resolves.toEqual(["github", "google"]);
    expect(mocks.dispatchWebServiceRequest).toHaveBeenCalledWith({
      method: "GET",
      path: "/internal/auth/sign-in-providers",
      traceId: "trace-1",
      correlationFields: {
        trace_id: "trace-1",
        request_id: "request-1",
      },
      transportOptions: {
        redirect: "manual",
        cache: "no-store",
      },
    });
  });

  it.each([
    Response.json({ providers: [] }),
    Response.json({ providers: ["github", "github"] }),
    Response.json({ providers: ["saml"] }),
    Response.json({ providers: "github" }),
    Response.json({ error: "sensitive upstream detail" }, { status: 503 }),
  ])("fails closed on an invalid or unavailable provider response", async (response) => {
    mocks.dispatchWebServiceRequest.mockResolvedValue(response);

    await expect(getEnabledSignInProviders()).rejects.toThrow("Sign-in providers are unavailable");
    expect(mocks.logError).toHaveBeenCalledOnce();
  });
});

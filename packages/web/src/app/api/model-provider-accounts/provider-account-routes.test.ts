import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/control-plane", () => ({ controlPlaneUserFetch: vi.fn() }));

import { controlPlaneUserFetch } from "@/lib/control-plane";
import { GET as listAccounts } from "./route";
import { PATCH as renameAccount } from "./[id]/route";
import { PUT as setDefault } from "../model-provider-account-defaults/[provider]/route";
import { POST as startDeviceAuthorization } from "./device-authorizations/[provider]/route";
import { DELETE as cancelDeviceAuthorization } from "./device-authorizations/[provider]/[transactionId]/route";
import { POST as pollDeviceAuthorization } from "./device-authorizations/[provider]/[transactionId]/poll/route";

describe("provider account BFF routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(controlPlaneUserFetch).mockImplementation(async () =>
      Response.json({ accounts: [] })
    );
  });

  it("forwards only supported account filters", async () => {
    await listAccounts(
      new NextRequest(
        "http://localhost/api/model-provider-accounts?provider=openai&status=active&archived=false&credential=secret"
      ),
      { params: Promise.resolve(undefined) }
    );

    expect(controlPlaneUserFetch).toHaveBeenCalledWith(
      "/model-provider-accounts?provider=openai&status=active&archived=false",
      undefined
    );
  });

  it("rejects a hostile account id before proxying", async () => {
    const response = await renameAccount(
      new NextRequest("http://localhost/api/model-provider-accounts/x", {
        method: "PATCH",
        headers: { Cookie: "openinspect.session_token=value" },
        body: JSON.stringify({ displayName: "Renamed" }),
      }),
      { params: Promise.resolve({ id: "../activation" }) }
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });

  it("rejects unknown providers before updating defaults", async () => {
    const response = await setDefault(
      new NextRequest("http://localhost/api/model-provider-account-defaults/unknown", {
        method: "PUT",
        headers: { Cookie: "openinspect.session_token=value" },
        body: JSON.stringify({ providerAccountId: "a".repeat(32) }),
      }),
      { params: Promise.resolve({ provider: "../openai" }) }
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });

  it("proxies device authorization start, poll, and cancel methods", async () => {
    const transactionId = "b".repeat(64);
    const cookie = { Cookie: "openinspect.session_token=value" };
    await startDeviceAuthorization(
      new NextRequest("http://localhost/api/model-provider-accounts/device-authorizations/openai", {
        method: "POST",
        headers: cookie,
        body: JSON.stringify({ operation: "create", displayName: "ChatGPT account" }),
      }),
      { params: Promise.resolve({ provider: "openai" }) }
    );
    await pollDeviceAuthorization(
      new NextRequest(
        `http://localhost/api/model-provider-accounts/device-authorizations/openai/${transactionId}/poll`,
        { method: "POST", headers: cookie, body: "{}" }
      ),
      { params: Promise.resolve({ provider: "openai", transactionId }) }
    );
    await cancelDeviceAuthorization(
      new NextRequest(
        `http://localhost/api/model-provider-accounts/device-authorizations/openai/${transactionId}`,
        { method: "DELETE", headers: cookie }
      ),
      { params: Promise.resolve({ provider: "openai", transactionId }) }
    );

    expect(controlPlaneUserFetch).toHaveBeenNthCalledWith(
      1,
      "/model-provider-accounts/openai/device-authorizations",
      expect.objectContaining({ method: "POST" })
    );
    expect(controlPlaneUserFetch).toHaveBeenNthCalledWith(
      2,
      `/model-provider-accounts/openai/device-authorizations/${transactionId}/poll`,
      expect.objectContaining({ method: "POST" })
    );
    expect(controlPlaneUserFetch).toHaveBeenNthCalledWith(
      3,
      `/model-provider-accounts/openai/device-authorizations/${transactionId}`,
      { method: "DELETE" }
    );
  });

  it("rejects invalid device authorization provider and transaction parameters", async () => {
    const invalidProvider = await startDeviceAuthorization(
      new NextRequest(
        "http://localhost/api/model-provider-accounts/device-authorizations/unknown",
        {
          method: "POST",
          headers: { Cookie: "openinspect.session_token=value" },
          body: "{}",
        }
      ),
      { params: Promise.resolve({ provider: "../openai" }) }
    );
    const invalidTransaction = await pollDeviceAuthorization(
      new NextRequest(
        "http://localhost/api/model-provider-accounts/device-authorizations/openai/unsafe/poll",
        { method: "POST", headers: { Cookie: "openinspect.session_token=value" }, body: "{}" }
      ),
      { params: Promise.resolve({ provider: "openai", transactionId: "../unsafe" }) }
    );

    expect(invalidProvider.status).toBe(400);
    expect(invalidTransaction.status).toBe(400);
    expect(invalidProvider.headers.get("Cache-Control")).toBe("private, no-store");
    expect(invalidTransaction.headers.get("Cache-Control")).toBe("private, no-store");
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });
});

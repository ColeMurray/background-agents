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
import { POST as startAuthorizationCode } from "./authorization-codes/[provider]/route";
import {
  DELETE as cancelAuthorizationCode,
  GET as readAuthorizationCode,
} from "./authorization-codes/[provider]/[transactionId]/route";
import { POST as completeAuthorizationCode } from "./authorization-codes/[provider]/[transactionId]/complete/route";

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

  it("proxies authorization code start, status, complete, and cancel methods", async () => {
    const transactionId = "f".repeat(64);
    const cookie = { Cookie: "openinspect.session_token=value" };
    const base = "http://localhost/api/model-provider-accounts/authorization-codes/anthropic";
    await startAuthorizationCode(
      new NextRequest(base, {
        method: "POST",
        headers: cookie,
        body: JSON.stringify({ operation: "create", displayName: "Claude account" }),
      }),
      { params: Promise.resolve({ provider: "anthropic" }) }
    );
    await readAuthorizationCode(new NextRequest(`${base}/${transactionId}`, { headers: cookie }), {
      params: Promise.resolve({ provider: "anthropic", transactionId }),
    });
    await completeAuthorizationCode(
      new NextRequest(`${base}/${transactionId}/complete`, {
        method: "POST",
        headers: cookie,
        body: JSON.stringify({ code: "code#state" }),
      }),
      { params: Promise.resolve({ provider: "anthropic", transactionId }) }
    );
    await cancelAuthorizationCode(
      new NextRequest(`${base}/${transactionId}`, { method: "DELETE", headers: cookie }),
      { params: Promise.resolve({ provider: "anthropic", transactionId }) }
    );

    expect(controlPlaneUserFetch).toHaveBeenNthCalledWith(
      1,
      "/model-provider-accounts/anthropic/authorization-codes",
      expect.objectContaining({ method: "POST" })
    );
    expect(controlPlaneUserFetch).toHaveBeenNthCalledWith(
      2,
      `/model-provider-accounts/anthropic/authorization-codes/${transactionId}`,
      undefined
    );
    expect(controlPlaneUserFetch).toHaveBeenNthCalledWith(
      3,
      `/model-provider-accounts/anthropic/authorization-codes/${transactionId}/complete`,
      expect.objectContaining({ method: "POST" })
    );
    expect(controlPlaneUserFetch).toHaveBeenNthCalledWith(
      4,
      `/model-provider-accounts/anthropic/authorization-codes/${transactionId}`,
      { method: "DELETE" }
    );
  });

  it("refuses authorization codes for a provider that connects by device authorization", async () => {
    const cookie = { Cookie: "openinspect.session_token=value" };
    const response = await startAuthorizationCode(
      new NextRequest("http://localhost/api/model-provider-accounts/authorization-codes/openai", {
        method: "POST",
        headers: cookie,
        body: JSON.stringify({ operation: "create", displayName: "ChatGPT" }),
      }),
      { params: Promise.resolve({ provider: "openai" }) }
    );

    expect(response.status).toBe(400);
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });

  it("rejects invalid authorization code provider and transaction parameters", async () => {
    const cookie = { Cookie: "openinspect.session_token=value" };
    const invalidProvider = await startAuthorizationCode(
      new NextRequest("http://localhost/api/model-provider-accounts/authorization-codes/unknown", {
        method: "POST",
        headers: cookie,
        body: "{}",
      }),
      { params: Promise.resolve({ provider: "../anthropic" }) }
    );
    const invalidStatus = await readAuthorizationCode(
      new NextRequest(
        "http://localhost/api/model-provider-accounts/authorization-codes/anthropic/unsafe",
        { headers: cookie }
      ),
      { params: Promise.resolve({ provider: "anthropic", transactionId: "../unsafe" }) }
    );
    const invalidCompletion = await completeAuthorizationCode(
      new NextRequest(
        "http://localhost/api/model-provider-accounts/authorization-codes/anthropic/unsafe/complete",
        { method: "POST", headers: cookie, body: JSON.stringify({ code: "x" }) }
      ),
      { params: Promise.resolve({ provider: "anthropic", transactionId: "b".repeat(63) }) }
    );

    for (const response of [invalidProvider, invalidStatus, invalidCompletion]) {
      expect(response.status).toBe(400);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    }
    expect(controlPlaneUserFetch).not.toHaveBeenCalled();
  });
});

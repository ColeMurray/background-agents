import { afterEach, describe, expect, it, vi } from "vitest";
import { decryptToken } from "../auth/crypto";
import {
  listCurrentManagedSecretValues,
  listManagedSecretHistory,
} from "../db/managed-secret-redaction-history";
import type { RequestContext } from "../routes/shared";
import type { Env } from "../types";
import { withExternalErrorContract } from "./error-contract";

vi.mock("../auth/crypto", () => ({ decryptToken: vi.fn() }));
vi.mock("../auth/provider-account-crypto", () => ({ decryptProviderAccountPayload: vi.fn() }));
vi.mock("../db/managed-secret-redaction-history", () => ({
  listCurrentManagedSecretValues: vi.fn(),
  listManagedSecretHistory: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("withExternalErrorContract", () => {
  it("fails closed without dropping response headers when credential redaction cannot decrypt", async () => {
    vi.mocked(listCurrentManagedSecretValues).mockResolvedValue([]);
    vi.mocked(listManagedSecretHistory).mockResolvedValue([]);
    vi.mocked(decryptToken).mockRejectedValue(new Error("invalid ciphertext"));
    const all = vi.fn().mockResolvedValue({ results: [{ encrypted_env: "not-json-ciphertext" }] });
    const ctx = {
      request_id: "request-1",
      trace_id: "trace-1",
      db: { prepare: vi.fn(() => ({ all })) },
    } as unknown as RequestContext;
    const env = {
      REPO_SECRETS_ENCRYPTION_KEY: "repo-key",
      TOKEN_ENCRYPTION_KEY: "token-key",
      PROVIDER_ACCOUNTS_ENCRYPTION_KEY: "provider-key",
    } as Env;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await withExternalErrorContract(
      Response.json(
        { error: "original response may contain a secret", code: "invalid_request" },
        { status: 400, headers: { "x-original": "preserved" } }
      ),
      "external-v1",
      env,
      ctx
    );

    expect(result.status).toBe(503);
    await expect(result.json()).resolves.toEqual({
      error: "Service unavailable",
      code: "service_unavailable",
      message: "Service unavailable",
      requestId: "request-1",
    });
    expect(result.headers.get("x-original")).toBe("preserved");
    expect(errors).toHaveBeenCalledOnce();
    expect(String(errors.mock.calls[0]?.[0])).toContain("external.redaction_unavailable");
  });
});

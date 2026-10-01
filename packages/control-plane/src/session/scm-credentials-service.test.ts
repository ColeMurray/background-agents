import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger";
import type { CredentialScope, SourceControlProvider } from "../source-control";
import { SourceControlProviderError } from "../source-control/errors";
import { ScmCredentialsService } from "./scm-credentials-service";

const credentialScope: CredentialScope = { kind: "repositories", repositoryIds: [99, 123] };

function createTestLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
}

function makeProvider(
  overrides: Partial<SourceControlProvider> & { name?: string } = {}
): SourceControlProvider {
  return {
    name: overrides.name ?? "github",
    generateCredentialHelperAuth: overrides.generateCredentialHelperAuth ?? vi.fn(),
    // Methods we never reach in these tests; cast lets us avoid stubbing the full surface.
  } as unknown as SourceControlProvider;
}

describe("ScmCredentialsService", () => {
  it("returns credentials on success", async () => {
    const expiresAtEpochMs = Date.now() + 60 * 60 * 1000;
    const provider = makeProvider({
      name: "github",
      generateCredentialHelperAuth: vi.fn().mockResolvedValue({
        username: "x-access-token",
        password: "ghs_token",
        expiresAtEpochMs,
      }),
    });

    const resolveCredentialScope = vi.fn(async () => credentialScope);
    const result = await new ScmCredentialsService(
      provider,
      createTestLogger(),
      resolveCredentialScope
    ).getCredentials();

    expect(result).toEqual({
      ok: true,
      username: "x-access-token",
      password: "ghs_token",
      expiresAtEpochMs,
    });
    expect(provider.generateCredentialHelperAuth).toHaveBeenCalledWith(credentialScope);
    expect(resolveCredentialScope).toHaveBeenCalledBefore(
      vi.mocked(provider.generateCredentialHelperAuth)
    );
  });

  it("rejects invalid provider credential payloads", async () => {
    const log = createTestLogger();
    const provider = makeProvider({
      generateCredentialHelperAuth: vi.fn().mockResolvedValue({
        username: "x-access-token",
        password: "",
        expiresAtEpochMs: Date.now() + 60 * 60 * 1000,
      }),
    });

    const result = await new ScmCredentialsService(
      provider,
      log,
      async () => credentialScope
    ).getCredentials();

    expect(result).toEqual({
      ok: false,
      status: 500,
      error: "Failed to generate SCM credentials",
    });
    expect(log.error).toHaveBeenCalledWith(
      "Provider returned invalid SCM credential helper auth",
      expect.objectContaining({ scm_provider: "github" })
    );
  });

  it("rejects expired provider credential payloads", async () => {
    const provider = makeProvider({
      generateCredentialHelperAuth: vi.fn().mockResolvedValue({
        username: "x-access-token",
        password: "ghs_token",
        expiresAtEpochMs: Date.now() - 1,
      }),
    });

    const result = await new ScmCredentialsService(
      provider,
      createTestLogger(),
      async () => credentialScope
    ).getCredentials();

    expect(result).toEqual({
      ok: false,
      status: 500,
      error: "Failed to generate SCM credentials",
    });
  });

  it("maps permanent provider errors to 500", async () => {
    const log = createTestLogger();
    const provider = makeProvider({
      name: "github",
      generateCredentialHelperAuth: vi
        .fn()
        .mockRejectedValue(new SourceControlProviderError("App not configured", "permanent")),
    });

    const result = await new ScmCredentialsService(
      provider,
      log,
      async () => credentialScope
    ).getCredentials();

    expect(result).toEqual({
      ok: false,
      status: 500,
      error: "App not configured",
    });
    expect(log.warn).toHaveBeenCalledWith(
      "SCM credential helper auth failed",
      expect.objectContaining({
        scm_provider: "github",
        error_type: "permanent",
        error: "App not configured",
      })
    );
  });

  it("maps transient provider errors to 502", async () => {
    const provider = makeProvider({
      generateCredentialHelperAuth: vi
        .fn()
        .mockRejectedValue(new SourceControlProviderError("GitHub API unavailable", "transient")),
    });

    const result = await new ScmCredentialsService(
      provider,
      createTestLogger(),
      async () => credentialScope
    ).getCredentials();

    expect(result).toEqual({ ok: false, status: 502, error: "GitHub API unavailable" });
  });

  it("falls back to 500 for unexpected errors", async () => {
    const log = createTestLogger();
    const provider = makeProvider({
      generateCredentialHelperAuth: vi.fn().mockRejectedValue(new Error("network blew up")),
    });

    const result = await new ScmCredentialsService(
      provider,
      log,
      async () => credentialScope
    ).getCredentials();

    expect(result).toEqual({
      ok: false,
      status: 500,
      error: "Failed to generate SCM credentials",
    });
    expect(log.error).toHaveBeenCalled();
  });

  it("resolves scope again for each credential request", async () => {
    const nextScope: CredentialScope = { kind: "repositories", repositoryIds: [456] };
    const resolveCredentialScope = vi
      .fn()
      .mockResolvedValueOnce(credentialScope)
      .mockResolvedValueOnce(nextScope);
    const provider = makeProvider({
      generateCredentialHelperAuth: vi.fn().mockResolvedValue({
        username: "x-access-token",
        password: "ghs_token",
        expiresAtEpochMs: Date.now() + 60 * 60 * 1000,
      }),
    });
    const service = new ScmCredentialsService(provider, createTestLogger(), resolveCredentialScope);

    await service.getCredentials();
    await service.getCredentials();

    expect(resolveCredentialScope).toHaveBeenCalledTimes(2);
    expect(provider.generateCredentialHelperAuth).toHaveBeenNthCalledWith(1, credentialScope);
    expect(provider.generateCredentialHelperAuth).toHaveBeenNthCalledWith(2, nextScope);
  });

  it.each(["permanent", "transient"] as const)(
    "preserves %s credential scope error mapping without minting credentials",
    async (errorType) => {
      const provider = makeProvider();
      const resolveCredentialScope = vi
        .fn()
        .mockRejectedValue(new SourceControlProviderError("Scope unavailable", errorType));

      const result = await new ScmCredentialsService(
        provider,
        createTestLogger(),
        resolveCredentialScope
      ).getCredentials();

      expect(result).toEqual({
        ok: false,
        status: errorType === "permanent" ? 500 : 502,
        error: "Scope unavailable",
      });
      expect(provider.generateCredentialHelperAuth).not.toHaveBeenCalled();
    }
  );
});

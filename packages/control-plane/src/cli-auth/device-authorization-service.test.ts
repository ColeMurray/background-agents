import { afterEach, describe, expect, it, vi } from "vitest";
import { hashToken } from "../auth/crypto";
import {
  CLI_CREDENTIAL_RETENTION_MS,
  CLI_CREDENTIAL_LIFETIME_MS,
  CLI_DEVICE_ATTEMPT_RETENTION_MS,
  CLI_DEVICE_AUTHORIZATION_LIFETIME_MS,
  CliDeviceAuthorizationError,
  CliDeviceAuthorizationService,
} from "./device-authorization-service";

describe("CliDeviceAuthorizationService", () => {
  afterEach(() => vi.restoreAllMocks());

  it("creates separate human and device secrets and persists only their hashes", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const store = {
      createAttempt: vi.fn(async () => undefined),
      pruneExpired: vi.fn(async () => undefined),
    };
    const service = new CliDeviceAuthorizationService(store as never);

    const started = await service.start("dev laptop");
    expect(started).toEqual({
      deviceSecret: expect.stringMatching(/^[0-9a-f]{64}$/),
      userCode: expect.stringMatching(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/),
      expiresAt: 1000 + CLI_DEVICE_AUTHORIZATION_LIFETIME_MS,
    });
    expect(store.createAttempt).toHaveBeenCalledWith({
      id: expect.stringMatching(/^[0-9a-f]{32}$/),
      deviceName: "dev laptop",
      deviceSecretHash: await hashToken(started.deviceSecret),
      userCodeHash: await hashToken(started.userCode),
      createdAt: 1000,
      expiresAt: 1000 + CLI_DEVICE_AUTHORIZATION_LIFETIME_MS,
    });
    expect(store.pruneExpired).toHaveBeenCalledWith({
      now: 1000,
      attemptRetentionMs: CLI_DEVICE_ATTEMPT_RETENTION_MS,
      credentialRetentionMs: CLI_CREDENTIAL_RETENTION_MS,
      limit: 100,
    });
  });

  it.each([
    [
      { status: "pending", deviceName: "dev laptop", expiresAt: 5000 },
      { deviceName: "dev laptop", expiresAt: 5000 },
    ],
    [{ status: "not_found" }, 404],
    [{ status: "expired" }, 410],
    [{ status: "unavailable" }, 409],
  ] as const)(
    "maps pending lookup state %# without exposing stored fields",
    async (outcome, expected) => {
      vi.spyOn(Date, "now").mockReturnValue(2000);
      const service = new CliDeviceAuthorizationService({
        getPendingAuthorization: vi.fn(async () => outcome),
      } as never);
      if (typeof expected === "number") {
        await expect(service.getPendingAuthorization("ABCD-EFGH")).rejects.toMatchObject({
          status: expected,
        });
      } else {
        await expect(service.getPendingAuthorization("ABCD-EFGH")).resolves.toEqual(expected);
      }
    }
  );

  it("issues a 30-day credential only to the atomic exchange winner", async () => {
    vi.spyOn(Date, "now").mockReturnValue(2000);
    const store = {
      exchangeApprovedAttempt: vi.fn(async () => ({ status: "issued" })),
    };
    const service = new CliDeviceAuthorizationService(store as never);

    const exchanged = await service.exchange("a".repeat(64));
    expect(exchanged).toEqual({
      status: "authorized",
      credential: expect.stringMatching(/^oi_cli_[0-9a-f]{64}$/),
      credentialId: expect.stringMatching(/^[0-9a-f]{32}$/),
      expiresAt: 2000 + CLI_CREDENTIAL_LIFETIME_MS,
    });
    if (exchanged.status !== "authorized") throw new Error("Expected an issued credential");
    expect(store.exchangeApprovedAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        claimId: expect.stringMatching(/^[0-9a-f]{32}$/),
        credentialId: exchanged.credentialId,
        credentialHash: await hashToken(exchanged.credential),
        credentialExpiresAt: 2000 + CLI_CREDENTIAL_LIFETIME_MS,
      })
    );
  });

  it("returns pending but rejects expired or already exchanged attempts", async () => {
    vi.spyOn(Date, "now").mockReturnValue(2000);
    const store = {
      exchangeApprovedAttempt: vi
        .fn()
        .mockResolvedValueOnce({ status: "pending", expiresAt: 5000 })
        .mockResolvedValueOnce({ status: "expired" })
        .mockResolvedValueOnce({ status: "consumed" }),
    };
    const service = new CliDeviceAuthorizationService(store as never);

    await expect(service.exchange("a".repeat(64))).resolves.toEqual({
      status: "pending",
      expiresAt: 5000,
    });
    await expect(service.exchange("a".repeat(64))).rejects.toMatchObject({ status: 410 });
    await expect(service.exchange("a".repeat(64))).rejects.toBeInstanceOf(
      CliDeviceAuthorizationError
    );
  });

  it("revokes by the hashed device-secret capability without exposing attempt state", async () => {
    vi.spyOn(Date, "now").mockReturnValue(3000);
    const store = { revokeIssuedCredentialByDeviceSecret: vi.fn(async () => undefined) };
    const service = new CliDeviceAuthorizationService(store as never);

    await expect(service.revokeIssuedCredential("a".repeat(64))).resolves.toBeUndefined();
    expect(store.revokeIssuedCredentialByDeviceSecret).toHaveBeenCalledWith(
      await hashToken("a".repeat(64)),
      3000
    );
  });
});

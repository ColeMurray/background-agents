import { describe, expect, it, vi } from "vitest";
import {
  CLI_CREDENTIAL_RETENTION_MS,
  CLI_CREDENTIAL_LIFETIME_MS,
  CLI_DEVICE_ATTEMPT_RETENTION_MS,
  CLI_DEVICE_AUTHORIZATION_LIFETIME_MS,
  CliDeviceAuthorizationError,
  CliDeviceAuthorizationService,
} from "./device-authorization-service";

describe("CliDeviceAuthorizationService", () => {
  it("creates separate human and device secrets and persists only their hashes", async () => {
    const store = {
      createAttempt: vi.fn(async () => undefined),
      pruneExpired: vi.fn(async () => undefined),
    };
    const service = new CliDeviceAuthorizationService(store as never, {
      now: () => 1000,
      generateSecret: () => "a".repeat(64),
      generateUserCode: () => "ABCD-EFGH",
      generateId: () => "attempt-id",
      hash: async (value) => `hash:${value}`,
    });

    await expect(service.start("dev laptop")).resolves.toEqual({
      deviceSecret: "a".repeat(64),
      userCode: "ABCD-EFGH",
      expiresAt: 1000 + CLI_DEVICE_AUTHORIZATION_LIFETIME_MS,
    });
    expect(store.createAttempt).toHaveBeenCalledWith({
      id: "attempt-id",
      deviceName: "dev laptop",
      deviceSecretHash: `hash:${"a".repeat(64)}`,
      userCodeHash: "hash:ABCD-EFGH",
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
      const service = new CliDeviceAuthorizationService(
        { getPendingAuthorization: vi.fn(async () => outcome) } as never,
        {
          now: () => 2000,
          generateSecret: () => "c".repeat(64),
          generateUserCode: () => "ABCD-EFGH",
          generateId: () => "id",
          hash: async (value) => `hash:${value}`,
        }
      );
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
    const store = {
      exchangeApprovedAttempt: vi.fn(async () => ({ status: "issued" })),
    };
    const values = ["credential-id", "claim-id", "c".repeat(64)];
    const service = new CliDeviceAuthorizationService(store as never, {
      now: () => 2000,
      generateSecret: () => values.pop()!,
      generateUserCode: () => "ABCD-EFGH",
      generateId: () => values.shift()!,
      hash: async (value) => `hash:${value}`,
    });

    await expect(service.exchange("a".repeat(64))).resolves.toEqual({
      status: "authorized",
      credential: `oi_cli_${"c".repeat(64)}`,
      credentialId: "credential-id",
      expiresAt: 2000 + CLI_CREDENTIAL_LIFETIME_MS,
    });
    expect(store.exchangeApprovedAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        claimId: "claim-id",
        credentialId: "credential-id",
        credentialHash: `hash:oi_cli_${"c".repeat(64)}`,
        credentialExpiresAt: 2000 + CLI_CREDENTIAL_LIFETIME_MS,
      })
    );
  });

  it("returns pending but rejects expired or already exchanged attempts", async () => {
    const store = {
      exchangeApprovedAttempt: vi
        .fn()
        .mockResolvedValueOnce({ status: "pending", expiresAt: 5000 })
        .mockResolvedValueOnce({ status: "expired" })
        .mockResolvedValueOnce({ status: "consumed" }),
    };
    const service = new CliDeviceAuthorizationService(store as never, {
      now: () => 2000,
      generateSecret: () => "c".repeat(64),
      generateUserCode: () => "ABCD-EFGH",
      generateId: () => crypto.randomUUID(),
      hash: async (value) => `hash:${value}`,
    });

    await expect(service.exchange("a".repeat(64))).resolves.toEqual({
      status: "pending",
      expiresAt: 5000,
    });
    await expect(service.exchange("a".repeat(64))).rejects.toMatchObject({ status: 410 });
    await expect(service.exchange("a".repeat(64))).rejects.toBeInstanceOf(
      CliDeviceAuthorizationError
    );
  });
});

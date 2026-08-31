import { describe, expect, it } from "vitest";
import {
  CLI_CREDENTIAL_PATTERN,
  CLI_DEVICE_SECRET_PATTERN,
  approveCliDeviceAuthorizationRequestSchema,
  cliDeviceAuthorizationExchangeRequestSchema,
  cliDeviceAuthorizationExchangeResponseSchema,
  cliMeResponseSchema,
  pendingCliDeviceAuthorizationResponseSchema,
  revokeCliDeviceAuthorizationRequestSchema,
  startCliDeviceAuthorizationRequestSchema,
  startCliDeviceAuthorizationResponseSchema,
} from "./cli-auth";

const DEVICE_SECRET = "a".repeat(64);
const CREDENTIAL = `oi_cli_${"b".repeat(64)}`;

describe("CLI authentication contracts", () => {
  it("accepts the separate device authorization inputs and start response", () => {
    expect(startCliDeviceAuthorizationRequestSchema.parse({ deviceName: "dev laptop" })).toEqual({
      deviceName: "dev laptop",
    });
    expect(
      startCliDeviceAuthorizationResponseSchema.parse({
        deviceSecret: DEVICE_SECRET,
        userCode: "ABCD-EFGH",
        verificationUrl: "https://app.example.com/cli/authorize?user_code=ABCD-EFGH",
        expiresAt: 1234,
        pollIntervalMs: 1000,
      })
    ).toMatchObject({ deviceSecret: DEVICE_SECRET, userCode: "ABCD-EFGH" });
    expect(CLI_DEVICE_SECRET_PATTERN.test(DEVICE_SECRET)).toBe(true);
  });

  it("does not allow the human code to be used as the device exchange secret", () => {
    expect(approveCliDeviceAuthorizationRequestSchema.parse({ userCode: "abcd-efgh" })).toEqual({
      userCode: "ABCD-EFGH",
    });
    expect(
      cliDeviceAuthorizationExchangeRequestSchema.safeParse({ deviceSecret: "ABCD-EFGH" }).success
    ).toBe(false);
    expect(
      revokeCliDeviceAuthorizationRequestSchema.parse({ deviceSecret: DEVICE_SECRET })
    ).toEqual({ deviceSecret: DEVICE_SECRET });
  });

  it("validates pending and authorized exchange responses", () => {
    expect(
      cliDeviceAuthorizationExchangeResponseSchema.parse({ status: "pending", expiresAt: 1234 })
    ).toEqual({ status: "pending", expiresAt: 1234 });
    expect(
      cliDeviceAuthorizationExchangeResponseSchema.parse({
        status: "authorized",
        credential: CREDENTIAL,
        credentialId: "credential-id",
        expiresAt: 5678,
      })
    ).toMatchObject({ status: "authorized", credential: CREDENTIAL });
  });

  it("limits pending authorization details to safe display metadata", () => {
    expect(
      pendingCliDeviceAuthorizationResponseSchema.parse({
        deviceName: "dev laptop",
        expiresAt: 1234,
      })
    ).toEqual({ deviceName: "dev laptop", expiresAt: 1234 });
    expect(
      pendingCliDeviceAuthorizationResponseSchema.safeParse({
        deviceName: "dev laptop",
        expiresAt: 1234,
        deviceSecretHash: "secret",
      }).success
    ).toBe(false);
  });

  it("validates credential and current-user responses without exposing hashes", () => {
    expect(CLI_CREDENTIAL_PATTERN.test(CREDENTIAL)).toBe(true);
    expect(
      cliMeResponseSchema.parse({
        installation: { name: "Acme Open-Inspect" },
        user: { id: "1".repeat(32), displayName: "Alice", email: "alice@example.com" },
        credential: { id: "credential-id", expiresAt: 5678 },
      })
    ).toMatchObject({ user: { id: "1".repeat(32) } });
  });

  it("rejects unknown fields and malformed secrets", () => {
    expect(
      startCliDeviceAuthorizationRequestSchema.safeParse({ deviceName: "laptop", scope: "admin" })
        .success
    ).toBe(false);
    expect(
      cliDeviceAuthorizationExchangeResponseSchema.safeParse({
        status: "authorized",
        credential: "not-a-cli-credential",
        credentialId: "credential-id",
        expiresAt: 5678,
      }).success
    ).toBe(false);
  });
});

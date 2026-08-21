import { describe, expect, it, vi } from "vitest";
import { XaiProviderDeviceAuthorization } from "./model-provider-account-xai-device-authorization";

describe("XaiProviderDeviceAuthorization", () => {
  it("creates a trusted connection from a successful device token response", async () => {
    const authorization = new XaiProviderDeviceAuthorization({
      start: vi.fn(),
      check: vi.fn().mockResolvedValue({
        status: "connected",
        tokens: {
          access_token: "access",
          refresh_token: "refresh",
          expires_in: 120,
        },
      }),
      accountId: vi.fn().mockResolvedValue("xai-user"),
      now: () => 1_000,
    });

    await expect(authorization.poll({ deviceCode: "device-secret" }, 5_000)).resolves.toEqual({
      status: "connected",
      connection: {
        credential: {
          refreshToken: "refresh",
          accessToken: "access",
          accessTokenExpiresAt: 121_000,
        },
        externalAccountId: "xai-user",
        accessTokenExpiresAt: 121_000,
      },
    });
  });

  it("fails closed when xAI does not return a trusted identity", async () => {
    const authorization = new XaiProviderDeviceAuthorization({
      start: vi.fn(),
      check: vi.fn().mockResolvedValue({
        status: "connected",
        tokens: { access_token: "opaque", refresh_token: "refresh" },
      }),
      accountId: vi.fn().mockRejectedValue(new Error("xAI user info returned invalid data")),
      now: () => 1_000,
    });

    await expect(authorization.poll({ deviceCode: "device-secret" }, 5_000)).rejects.toThrow(
      "user info returned invalid data"
    );
  });

  it("uses the canonical provider access-token lifetime when xAI omits expiry", async () => {
    const authorization = new XaiProviderDeviceAuthorization({
      start: vi.fn(),
      check: vi.fn().mockResolvedValue({
        status: "connected",
        tokens: { access_token: "access", refresh_token: "refresh" },
      }),
      accountId: vi.fn().mockResolvedValue("xai-user"),
      now: () => 1_000,
    });

    await expect(authorization.poll({ deviceCode: "device-secret" }, 5_000)).resolves.toMatchObject(
      {
        connection: { accessTokenExpiresAt: 3_601_000 },
      }
    );
  });
});

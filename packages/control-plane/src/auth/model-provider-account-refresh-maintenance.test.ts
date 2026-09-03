import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger";
import {
  ANTHROPIC_REFRESH_BATCH_LIMIT,
  ANTHROPIC_REFRESH_LOOKAHEAD_MS,
  ModelProviderAccountRefreshMaintenance,
} from "./model-provider-account-refresh-maintenance";

function createSubject(ids: string[], getAccess = vi.fn(async () => ({ accessToken: "token" }))) {
  const credentials = {
    listDueRefreshAccountIds: vi.fn(async () => ids),
  };
  const logger = { info: vi.fn(), error: vi.fn() } as unknown as Logger;
  const maintenance = new ModelProviderAccountRefreshMaintenance(
    credentials,
    { getAccess },
    logger,
    () => 1_000_000
  );
  return { maintenance, credentials, getAccess, logger };
}

describe("ModelProviderAccountRefreshMaintenance", () => {
  it("queries the bounded Anthropic lookahead and refreshes each due account through the broker", async () => {
    const { maintenance, credentials, getAccess } = createSubject(["account-1", "account-2"]);

    await expect(maintenance.run()).resolves.toEqual({ due: 2, refreshed: 2, failed: 0 });

    expect(credentials.listDueRefreshAccountIds).toHaveBeenCalledWith(
      "anthropic",
      1_000_000 + ANTHROPIC_REFRESH_LOOKAHEAD_MS,
      ANTHROPIC_REFRESH_BATCH_LIMIT
    );
    expect(getAccess.mock.calls).toEqual([
      ["account-1", "anthropic"],
      ["account-2", "anthropic"],
    ]);
  });

  it("uses safe sequential execution", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const getAccess = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return { accessToken: "token" };
    });
    const { maintenance } = createSubject(["account-1", "account-2", "account-3"], getAccess);

    await maintenance.run();

    expect(maxInFlight).toBe(1);
  });

  it("continues after a per-account failure and returns summary stats", async () => {
    const getAccess = vi
      .fn()
      .mockResolvedValueOnce({ accessToken: "token-1" })
      .mockRejectedValueOnce(new Error("upstream unavailable"))
      .mockResolvedValueOnce({ accessToken: "token-3" });
    const { maintenance, logger } = createSubject(
      ["account-1", "account-2", "account-3"],
      getAccess
    );

    await expect(maintenance.run()).resolves.toEqual({ due: 3, refreshed: 2, failed: 1 });
    expect(getAccess).toHaveBeenCalledTimes(3);
    expect(logger.error).toHaveBeenCalledWith(
      "provider_account.proactive_refresh_failed",
      expect.objectContaining({
        event: "provider_account.proactive_refresh_failed",
        provider_account_id: "account-2",
        provider: "anthropic",
        error_name: "Error",
      })
    );
    expect(logger.error).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ error: expect.anything() })
    );
  });

  it("returns an empty summary without broker calls", async () => {
    const { maintenance, getAccess } = createSubject([]);

    await expect(maintenance.run()).resolves.toEqual({ due: 0, refreshed: 0, failed: 0 });
    expect(getAccess).not.toHaveBeenCalled();
  });
});

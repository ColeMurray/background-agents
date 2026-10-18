import { describe, expect, it } from "vitest";
import {
  PI_FEATURE_CAPABILITY_SNAPSHOT_KEY,
  latchPiFeatureCapabilitySnapshot,
} from "./capability-snapshot";

function storage(initial?: unknown) {
  const values = new Map<string, unknown>();
  if (initial !== undefined) values.set(PI_FEATURE_CAPABILITY_SNAPSHOT_KEY, initial);
  return {
    values,
    port: {
      get: async (key: string) => values.get(key),
      put: async (key: string, value: unknown) => {
        values.set(key, value);
      },
    },
  };
}

describe("latchPiFeatureCapabilitySnapshot", () => {
  it("durably writes one complete versioned snapshot for a new session", async () => {
    const fake = storage();

    const snapshot = await latchPiFeatureCapabilitySnapshot(fake.port, {
      workspace: "read_only",
      repositoryEditing: "enabled",
    });

    expect(snapshot).toEqual({
      version: 1,
      capabilities: {
        workspace: "read_only",
        repositoryEditing: "enabled",
        codeMode: "off",
        sandboxExecution: "off",
        externalActions: "off",
        mcp: "off",
      },
    });
    expect(fake.values.get(PI_FEATURE_CAPABILITY_SNAPSHOT_KEY)).toEqual(snapshot);
  });

  it("keeps the durable session snapshot when deployment admission flags change", async () => {
    const original = {
      version: 1,
      capabilities: {
        workspace: "read_only",
        repositoryEditing: "off",
        codeMode: "off",
        sandboxExecution: "off",
        externalActions: "off",
        mcp: "off",
      },
    };
    const fake = storage(original);

    await expect(
      latchPiFeatureCapabilitySnapshot(fake.port, { workspace: "off", codeMode: "enabled" })
    ).resolves.toEqual(original);
    expect(fake.values.get(PI_FEATURE_CAPABILITY_SNAPSHOT_KEY)).toBe(original);
  });

  it("fails closed on a malformed durable snapshot instead of relatching wider flags", async () => {
    const fake = storage({ version: 999, capabilities: {} });

    await expect(
      latchPiFeatureCapabilitySnapshot(fake.port, { workspace: "enabled" })
    ).rejects.toThrow();
    expect(fake.values.get(PI_FEATURE_CAPABILITY_SNAPSHOT_KEY)).toEqual({
      version: 999,
      capabilities: {},
    });
  });
});

import { describe, expect, it } from "vitest";
import {
  PI_LEGACY_FEATURE_CAPABILITY_SNAPSHOT,
  PI_FEATURE_CAPABILITY_SNAPSHOT_KEY,
  readPiFeatureCapabilitySnapshot,
} from "./capability-snapshot";

function storage(initial?: unknown) {
  const values = new Map<string, unknown>();
  if (initial !== undefined) values.set(PI_FEATURE_CAPABILITY_SNAPSHOT_KEY, initial);
  return {
    values,
    port: {
      get: async (key: string) => values.get(key),
    },
  };
}

describe("readPiFeatureCapabilitySnapshot", () => {
  it("does not infer deployment capabilities when durable authority is absent", async () => {
    const fake = storage();

    await expect(readPiFeatureCapabilitySnapshot(fake.port)).resolves.toBeUndefined();
    expect(PI_LEGACY_FEATURE_CAPABILITY_SNAPSHOT).toEqual({
      version: 2,
      capabilities: {
        workspace: "off",
        repositoryEditing: "off",
        codeMode: "off",
        sandboxExecution: "off",
        externalActions: "off",
        mcp: "off",
        crossSessionMessaging: "off",
      },
    });
  });

  it("returns the exact complete durable snapshot", async () => {
    const original = {
      version: 2,
      capabilities: {
        workspace: "read_only",
        repositoryEditing: "off",
        codeMode: "off",
        sandboxExecution: "off",
        externalActions: "off",
        mcp: "off",
        crossSessionMessaging: "off",
      },
    };
    const fake = storage(original);

    await expect(readPiFeatureCapabilitySnapshot(fake.port)).resolves.toEqual(original);
    expect(fake.values.get(PI_FEATURE_CAPABILITY_SNAPSHOT_KEY)).toBe(original);
  });

  it("reads an older snapshot with the newer feature closed", async () => {
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

    await expect(readPiFeatureCapabilitySnapshot(fake.port)).resolves.toEqual({
      version: 2,
      capabilities: {
        workspace: "read_only",
        repositoryEditing: "off",
        codeMode: "off",
        sandboxExecution: "off",
        externalActions: "off",
        mcp: "off",
        crossSessionMessaging: "off",
      },
    });
    // The stored snapshot is left exactly as it was found.
    expect(fake.values.get(PI_FEATURE_CAPABILITY_SNAPSHOT_KEY)).toBe(original);
  });

  it("fails closed on a malformed durable snapshot instead of relatching wider flags", async () => {
    const fake = storage({ version: 999, capabilities: {} });

    await expect(readPiFeatureCapabilitySnapshot(fake.port)).rejects.toThrow();
    expect(fake.values.get(PI_FEATURE_CAPABILITY_SNAPSHOT_KEY)).toEqual({
      version: 999,
      capabilities: {},
    });
  });
});

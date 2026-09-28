import { describe, expect, it } from "vitest";
import { createTestEnv } from "../router.test-support";
import type { Env } from "../types";
import {
  getImageBuildsUnsupportedMessage,
  resolveImageBuildAdmission,
  resolveImageBuildProvider,
} from "./provider-policy";

function env(overrides: Partial<Env> = {}): Env {
  return createTestEnv(overrides);
}

/** Every value `resolveSandboxBackendName` accepts. */
const SANDBOX_BACKENDS = ["modal", "vercel", "opencomputer", "e2b", "daytona"] as const;

describe("resolveImageBuildProvider", () => {
  it.each(SANDBOX_BACKENDS)("resolves %s as an image-build provider", (provider) => {
    expect(resolveImageBuildProvider(provider)).toBe(provider);
  });

  it("reports no unsupported provider for every image-capable backend", () => {
    for (const provider of SANDBOX_BACKENDS) {
      expect(getImageBuildsUnsupportedMessage(env({ SANDBOX_PROVIDER: provider }))).toBeNull();
    }
  });

  it("keeps Boat repo and environment image builds unsupported", () => {
    expect(resolveImageBuildProvider("boat")).toBeNull();
    expect(getImageBuildsUnsupportedMessage(env({ SANDBOX_PROVIDER: "boat" }))).toContain(
      "Image builds are only available"
    );
    expect(resolveImageBuildAdmission(env({ SANDBOX_PROVIDER: "boat" }))).toEqual({
      provider: null,
      admitted: false,
      reason: "provider_unsupported",
    });
  });
});

describe("resolveImageBuildAdmission", () => {
  it.each(["modal", "vercel", "opencomputer", "e2b"])(
    "admits %s without an operator flag",
    (provider) => {
      expect(resolveImageBuildAdmission(env({ SANDBOX_PROVIDER: provider }))).toEqual({
        provider,
        admitted: true,
      });
    }
  );

  it("keeps Daytona closed until an operator opens it", () => {
    expect(resolveImageBuildAdmission(env({ SANDBOX_PROVIDER: "daytona" }))).toEqual({
      provider: "daytona",
      admitted: false,
      reason: "daytona_prebuilds_disabled",
    });
  });

  it.each(["true", "1", " TRUE "])("opens Daytona admission for %p", (flag) => {
    expect(
      resolveImageBuildAdmission(
        env({ SANDBOX_PROVIDER: "daytona", DAYTONA_PREBUILDS_ENABLED: flag })
      )
    ).toEqual({ provider: "daytona", admitted: true });
  });

  it.each(["false", "0", "", "yes"])("leaves Daytona admission closed for %p", (flag) => {
    expect(
      resolveImageBuildAdmission(
        env({ SANDBOX_PROVIDER: "daytona", DAYTONA_PREBUILDS_ENABLED: flag })
      )
    ).toMatchObject({ admitted: false, reason: "daytona_prebuilds_disabled" });
  });
});

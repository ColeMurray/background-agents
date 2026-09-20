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

/** Sandbox backends that support repository image builds. */
const IMAGE_BUILD_BACKENDS = ["modal", "vercel", "opencomputer", "e2b", "daytona"] as const;

describe("resolveImageBuildProvider", () => {
  it.each(IMAGE_BUILD_BACKENDS)("resolves %s as an image-build provider", (provider) => {
    expect(resolveImageBuildProvider(provider)).toBe(provider);
  });

  it("reports no unsupported message for image-build backends", () => {
    for (const provider of IMAGE_BUILD_BACKENDS) {
      expect(getImageBuildsUnsupportedMessage(env({ SANDBOX_PROVIDER: provider }))).toBeNull();
    }
  });

  it("reports Sandbox0 repository image builds as unsupported", () => {
    expect(resolveImageBuildProvider("sandbox0")).toBeNull();
    expect(getImageBuildsUnsupportedMessage(env({ SANDBOX_PROVIDER: "sandbox0" }))).toEqual(
      expect.any(String)
    );
  });
});

describe("resolveImageBuildAdmission", () => {
  it("keeps Sandbox0 admission closed even when Daytona prebuilds are enabled", () => {
    expect(
      resolveImageBuildAdmission(
        env({ SANDBOX_PROVIDER: "sandbox0", DAYTONA_PREBUILDS_ENABLED: "true" })
      )
    ).toEqual({ provider: null, admitted: false, reason: "provider_unsupported" });
  });

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

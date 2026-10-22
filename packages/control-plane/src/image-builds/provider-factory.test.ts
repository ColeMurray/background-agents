import { describe, expect, it } from "vitest";
import { createTestEnv } from "../router.test-support";
import type { Env } from "../types";
import { createImageBuildAdapterFactory } from "./provider-factory";

function createEnv(overrides: Partial<Env>): Env {
  return createTestEnv({ TOKEN_ENCRYPTION_KEY: "test-token-key", ...overrides });
}

describe("createImageBuildAdapterFactory", () => {
  it("needs a base snapshot to start a Daytona image build, but not to reclaim one", () => {
    const env = createEnv({
      DAYTONA_API_URL: "https://daytona.test",
      DAYTONA_API_KEY: "daytona-key",
    });
    const factory = createImageBuildAdapterFactory(env);

    expect(() => factory.create("daytona", "start")).toThrow(
      "DAYTONA_BASE_SNAPSHOT is required to create Daytona sandboxes"
    );
    // A deployment that switched providers keeps credentials but stops
    // building a base image; finalization and cleanup must still construct.
    expect(factory.create("daytona", "existing_session")).toBeDefined();
  });

  it("needs a base snapshot to start a Boat image build, but not to reclaim one", () => {
    const factory = createImageBuildAdapterFactory(createEnv({ BOAT_API_KEY: "boat_key" }));

    expect(() => factory.create("boat", "start")).toThrow(
      "BOAT_BASE_SNAPSHOT is required to start a Boat image build"
    );
    // Images and build sources recorded against Boat are finalized and
    // reclaimed after a provider switch, when no base snapshot is built.
    expect(factory.create("boat", "existing_session")).toBeDefined();
    expect(
      createImageBuildAdapterFactory(
        createEnv({ BOAT_API_KEY: "boat_key", BOAT_BASE_SNAPSHOT: "open-inspect-abc" })
      ).create("boat", "start")
    ).toBeDefined();
  });

  it("still requires Boat credentials for every operation", () => {
    const factory = createImageBuildAdapterFactory(
      createEnv({ BOAT_BASE_SNAPSHOT: "open-inspect-abc" })
    );

    expect(() => factory.create("boat", "existing_session")).toThrow("BOAT_API_KEY is required");
  });

  it("still requires Daytona credentials for every operation", () => {
    const factory = createImageBuildAdapterFactory(
      createEnv({ DAYTONA_API_URL: "https://daytona.test" })
    );

    expect(() => factory.create("daytona", "existing_session")).toThrow(
      "DAYTONA_API_URL and DAYTONA_API_KEY are required"
    );
  });
});

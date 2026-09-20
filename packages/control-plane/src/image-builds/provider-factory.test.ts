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

  it("still requires Daytona credentials for every operation", () => {
    const factory = createImageBuildAdapterFactory(
      createEnv({ DAYTONA_API_URL: "https://daytona.test" })
    );

    expect(() => factory.create("daytona", "existing_session")).toThrow(
      "DAYTONA_API_URL and DAYTONA_API_KEY are required"
    );
  });
});

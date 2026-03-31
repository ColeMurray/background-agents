import { describe, it, expect, vi } from "vitest";

// Mock @cloudflare/containers before importing SandboxContainer (extends Container)
vi.mock("@cloudflare/containers", () => ({
  Container: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

// Must import AFTER vi.mock so the hoisted mock is in place
const { SANDBOX_DEFAULT_PORT, SANDBOX_CODE_SERVER_PORT, SANDBOX_SLEEP_AFTER } = await import(
  "./sandbox-container"
);

describe("SandboxContainer", () => {
  // SandboxContainer extends Container which requires workerd runtime.
  // We test the configuration constants and types here; integration tests
  // cover the full lifecycle.

  it("exports SANDBOX_DEFAULT_PORT", () => {
    expect(SANDBOX_DEFAULT_PORT).toBe(4096);
  });

  it("exports SANDBOX_CODE_SERVER_PORT", () => {
    expect(SANDBOX_CODE_SERVER_PORT).toBe(8080);
  });

  it("exports SANDBOX_SLEEP_AFTER", () => {
    expect(SANDBOX_SLEEP_AFTER).toBe("60m");
  });
});

import { describe, it, expect, vi } from "vitest";

// Mock cloudflare:workers (required in Node test environment)
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {},
}));

// Mock @cloudflare/sandbox since it depends on cloudflare:workers internals
vi.mock("@cloudflare/sandbox", () => {
  class MockSandbox {}
  function mockGetSandbox() {
    return new MockSandbox();
  }
  return {
    Sandbox: MockSandbox,
    getSandbox: mockGetSandbox,
  };
});

describe("SandboxContainer exports", () => {
  it("re-exports SandboxContainer from @cloudflare/sandbox", async () => {
    const { SandboxContainer } = await import("./sandbox-container");
    expect(SandboxContainer).toBeDefined();
  });

  it("re-exports getSandbox from @cloudflare/sandbox", async () => {
    const { getSandbox } = await import("./sandbox-container");
    expect(getSandbox).toBeDefined();
    expect(typeof getSandbox).toBe("function");
  });
});

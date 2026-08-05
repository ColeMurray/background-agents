import { describe, it, expect } from "vitest";
import { resolveSandboxBackendName } from "./provider-name";

describe("resolveSandboxBackendName", () => {
  it("defaults to modal when undefined", () => {
    expect(resolveSandboxBackendName(undefined)).toBe("modal");
  });

  it("defaults to modal when empty string", () => {
    expect(resolveSandboxBackendName("")).toBe("modal");
  });

  it("defaults to modal when whitespace-only", () => {
    expect(resolveSandboxBackendName("   ")).toBe("modal");
  });

  it('returns "modal" for "modal"', () => {
    expect(resolveSandboxBackendName("modal")).toBe("modal");
  });

  it('returns "e2b" for "e2b"', () => {
    expect(resolveSandboxBackendName("e2b")).toBe("e2b");
  });

  it('returns "daytona" for "daytona"', () => {
    expect(resolveSandboxBackendName("daytona")).toBe("daytona");
  });

  it('returns "vercel" for "vercel"', () => {
    expect(resolveSandboxBackendName("vercel")).toBe("vercel");
  });

  it('returns "opencomputer" for "opencomputer"', () => {
    expect(resolveSandboxBackendName("opencomputer")).toBe("opencomputer");
  });

  it("is case-insensitive", () => {
    expect(resolveSandboxBackendName("MODAL")).toBe("modal");
    expect(resolveSandboxBackendName("Daytona")).toBe("daytona");
    expect(resolveSandboxBackendName("E2B")).toBe("e2b");
    expect(resolveSandboxBackendName("DAYTONA")).toBe("daytona");
    expect(resolveSandboxBackendName("VERCEL")).toBe("vercel");
    expect(resolveSandboxBackendName("OPENCOMPUTER")).toBe("opencomputer");
  });

  it("trims whitespace", () => {
    expect(resolveSandboxBackendName("  modal  ")).toBe("modal");
    expect(resolveSandboxBackendName("  daytona  ")).toBe("daytona");
    expect(resolveSandboxBackendName("  vercel  ")).toBe("vercel");
    expect(resolveSandboxBackendName("  opencomputer  ")).toBe("opencomputer");
    expect(resolveSandboxBackendName("  e2b  ")).toBe("e2b");
  });

  it("throws for unsupported provider", () => {
    expect(() => resolveSandboxBackendName("k8s")).toThrow("Unsupported SANDBOX_PROVIDER: k8s");
    expect(() => resolveSandboxBackendName("fly")).toThrow("Unsupported SANDBOX_PROVIDER: fly");
  });
});

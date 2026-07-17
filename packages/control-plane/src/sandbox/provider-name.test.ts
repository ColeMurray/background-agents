import { describe, it, expect } from "vitest";
import { resolveSandboxBackendName, isModalSandboxBackend } from "./provider-name";

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

  it('returns "superserve" for "superserve"', () => {
    expect(resolveSandboxBackendName("superserve")).toBe("superserve");
  });

  it("is case-insensitive", () => {
    expect(resolveSandboxBackendName("MODAL")).toBe("modal");
    expect(resolveSandboxBackendName("Daytona")).toBe("daytona");
    expect(resolveSandboxBackendName("E2B")).toBe("e2b");
    expect(resolveSandboxBackendName("DAYTONA")).toBe("daytona");
    expect(resolveSandboxBackendName("VERCEL")).toBe("vercel");
    expect(resolveSandboxBackendName("OPENCOMPUTER")).toBe("opencomputer");
    expect(resolveSandboxBackendName("SUPERSERVE")).toBe("superserve");
  });

  it("trims whitespace", () => {
    expect(resolveSandboxBackendName("  modal  ")).toBe("modal");
    expect(resolveSandboxBackendName("  daytona  ")).toBe("daytona");
    expect(resolveSandboxBackendName("  vercel  ")).toBe("vercel");
    expect(resolveSandboxBackendName("  opencomputer  ")).toBe("opencomputer");
    expect(resolveSandboxBackendName("  e2b  ")).toBe("e2b");
    expect(resolveSandboxBackendName("  superserve  ")).toBe("superserve");
  });

  it("throws for unsupported provider", () => {
    expect(() => resolveSandboxBackendName("k8s")).toThrow("Unsupported SANDBOX_PROVIDER: k8s");
    expect(() => resolveSandboxBackendName("fly")).toThrow("Unsupported SANDBOX_PROVIDER: fly");
  });
});

describe("isModalSandboxBackend", () => {
  it("returns true for modal", () => {
    expect(isModalSandboxBackend("modal")).toBe(true);
  });

  it("returns true for undefined (default)", () => {
    expect(isModalSandboxBackend(undefined)).toBe(true);
  });

  it("returns false for e2b", () => {
    expect(isModalSandboxBackend("e2b")).toBe(false);
  });

  it("returns false for daytona", () => {
    expect(isModalSandboxBackend("daytona")).toBe(false);
  });

  it("returns false for vercel", () => {
    expect(isModalSandboxBackend("vercel")).toBe(false);
  });

  it("returns false for opencomputer", () => {
    expect(isModalSandboxBackend("opencomputer")).toBe(false);
  });

  it("returns false for superserve", () => {
    expect(isModalSandboxBackend("superserve")).toBe(false);
  });
});

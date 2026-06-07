import { describe, it, expect } from "vitest";
import {
  resolveSandboxBackendName,
  isModalSandboxBackend,
  supportsRepoImageBackend,
} from "./provider-name";

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

  it('returns "daytona" for "daytona"', () => {
    expect(resolveSandboxBackendName("daytona")).toBe("daytona");
  });

  it('returns "vercel" for "vercel"', () => {
    expect(resolveSandboxBackendName("vercel")).toBe("vercel");
  });

  it("is case-insensitive", () => {
    expect(resolveSandboxBackendName("MODAL")).toBe("modal");
    expect(resolveSandboxBackendName("Daytona")).toBe("daytona");
    expect(resolveSandboxBackendName("DAYTONA")).toBe("daytona");
    expect(resolveSandboxBackendName("VERCEL")).toBe("vercel");
  });

  it("trims whitespace", () => {
    expect(resolveSandboxBackendName("  modal  ")).toBe("modal");
    expect(resolveSandboxBackendName("  daytona  ")).toBe("daytona");
    expect(resolveSandboxBackendName("  vercel  ")).toBe("vercel");
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

  it("returns false for daytona", () => {
    expect(isModalSandboxBackend("daytona")).toBe(false);
  });

  it("returns false for vercel", () => {
    expect(isModalSandboxBackend("vercel")).toBe(false);
  });
});

describe("supportsRepoImageBackend", () => {
  it("returns true for modal and vercel", () => {
    expect(supportsRepoImageBackend("modal")).toBe(true);
    expect(supportsRepoImageBackend("vercel")).toBe(true);
    expect(supportsRepoImageBackend(undefined)).toBe(true);
  });

  it("returns false for daytona", () => {
    expect(supportsRepoImageBackend("daytona")).toBe(false);
  });
});

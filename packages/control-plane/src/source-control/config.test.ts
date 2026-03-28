import { describe, expect, it } from "vitest";
import { SourceControlProviderError } from "./errors";
import { DEFAULT_SCM_PROVIDER, resolveScmProviderFromEnv } from "./config";

describe("resolveScmProviderFromEnv", () => {
  it("defaults to github when SCM_PROVIDER is unset", () => {
    expect(resolveScmProviderFromEnv(undefined)).toBe(DEFAULT_SCM_PROVIDER);
  });

  it("normalizes case and whitespace", () => {
    expect(resolveScmProviderFromEnv("  GITHUB ")).toBe("github");
    expect(resolveScmProviderFromEnv(" bitbucket ")).toBe("bitbucket");
    expect(resolveScmProviderFromEnv("  GITLAB  ")).toBe("gitlab");
  });

  it("accepts gitlab as a valid provider", () => {
    expect(resolveScmProviderFromEnv("gitlab")).toBe("gitlab");
  });

  it("throws for unknown provider values", () => {
    expect(() => resolveScmProviderFromEnv("unknown")).toThrow(SourceControlProviderError);
    expect(() => resolveScmProviderFromEnv("unknown")).toThrow(
      "Invalid SCM_PROVIDER value 'unknown'"
    );
  });
});

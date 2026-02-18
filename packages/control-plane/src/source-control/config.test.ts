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
  });

  it("throws for unknown provider values", () => {
    expect(() => resolveScmProviderFromEnv("gitlab")).toThrow(SourceControlProviderError);
    expect(() => resolveScmProviderFromEnv("gitlab")).toThrow(
      "Invalid SCM_PROVIDER value 'gitlab'"
    );
  });
});

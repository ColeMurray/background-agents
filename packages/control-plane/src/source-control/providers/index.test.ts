import { describe, expect, it } from "vitest";
import { createSourceControlProvider } from "./index";
import { GitHubSourceControlProvider } from "./github-provider";
import { SourceControlProviderError } from "../errors";

describe("createSourceControlProvider", () => {
  it("creates github provider", () => {
    const provider = createSourceControlProvider({ provider: "github" });
    expect(provider).toBeInstanceOf(GitHubSourceControlProvider);
  });

  it("throws explicit not-implemented error for bitbucket", () => {
    const createBitbucketProvider = () =>
      createSourceControlProvider({
        provider: "bitbucket",
      });

    expect(createBitbucketProvider).toThrow(SourceControlProviderError);
    expect(createBitbucketProvider).toThrow(
      "SCM provider 'bitbucket' is configured but not implemented."
    );
  });

  it("throws for unknown provider values at runtime", () => {
    expect(() =>
      createSourceControlProvider({
        provider: "gitlab" as unknown as "github",
      })
    ).toThrow("Unsupported source control provider: gitlab");
  });
});

import { describe, expect, it } from "vitest";
import { createSourceControlProvider } from "./index";
import { BitbucketSourceControlProvider } from "./bitbucket-provider";
import { GitHubSourceControlProvider } from "./github-provider";

describe("createSourceControlProvider", () => {
  it("creates github provider", () => {
    const provider = createSourceControlProvider({ provider: "github" });
    expect(provider).toBeInstanceOf(GitHubSourceControlProvider);
  });

  it("creates bitbucket provider", () => {
    const provider = createSourceControlProvider({ provider: "bitbucket" });
    expect(provider).toBeInstanceOf(BitbucketSourceControlProvider);
  });

  it("throws for unknown provider values at runtime", () => {
    expect(() =>
      createSourceControlProvider({
        provider: "gitlab" as unknown as "github",
      })
    ).toThrow("Unsupported source control provider: gitlab");
  });
});

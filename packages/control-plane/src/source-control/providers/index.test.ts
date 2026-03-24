import { describe, expect, it } from "vitest";
import { createSourceControlProvider } from "./index";
import { GitHubSourceControlProvider } from "./github-provider";
import { GitLabSourceControlProvider } from "./gitlab-provider";
import { SourceControlProviderError } from "../errors";

describe("createSourceControlProvider", () => {
  it("creates github provider", () => {
    const provider = createSourceControlProvider({ provider: "github" });
    expect(provider).toBeInstanceOf(GitHubSourceControlProvider);
  });

  it("creates gitlab provider when config is provided", () => {
    const provider = createSourceControlProvider({
      provider: "gitlab",
      gitlab: { accessToken: "glpat-test" },
    });
    expect(provider).toBeInstanceOf(GitLabSourceControlProvider);
  });

  it("throws for gitlab without configuration", () => {
    expect(() => createSourceControlProvider({ provider: "gitlab" })).toThrow(
      SourceControlProviderError
    );
    expect(() => createSourceControlProvider({ provider: "gitlab" })).toThrow(
      "SCM provider 'gitlab' requires gitlab configuration."
    );
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
        provider: "unknown" as unknown as "github",
      })
    ).toThrow("Unsupported source control provider: unknown");
  });
});

import { describe, expect, it } from "vitest";
import { createSourceControlProvider } from "./index";
import { GitHubSourceControlProvider } from "./github-provider";

describe("createSourceControlProvider", () => {
  it("creates github provider", () => {
    const provider = createSourceControlProvider({ provider: "github" });
    expect(provider).toBeInstanceOf(GitHubSourceControlProvider);
  });
});

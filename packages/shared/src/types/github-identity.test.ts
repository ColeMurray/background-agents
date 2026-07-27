import { describe, expect, it } from "vitest";

import { formatGitHubNoreplyEmail, githubLoginSchema } from ".";

describe("GitHub identity rules", () => {
  it("formats the canonical GitHub noreply address", () => {
    expect(formatGitHubNoreplyEmail({ id: "1001", login: "octocat" })).toBe(
      "1001+octocat@users.noreply.github.com"
    );
  });

  it.each(["octocat", "open-inspect-bot", "a", "a1"])("accepts the valid login %s", (login) => {
    expect(githubLoginSchema.safeParse(login).success).toBe(true);
  });

  it.each(["-octocat", "octocat-", "open--inspect", "octocat@example.com", ""])(
    "rejects the invalid login %s",
    (login) => {
      expect(githubLoginSchema.safeParse(login).success).toBe(false);
    }
  );
});

import { describe, expect, it } from "vitest";

import { githubEmailListSchema } from "./github-email-schema";

describe("githubEmailListSchema", () => {
  it("parses valid GitHub email API responses", () => {
    const result = githubEmailListSchema.safeParse([
      { email: "user@example.com", primary: true, verified: true, visibility: "private" },
    ]);

    expect(result.success).toBe(true);
  });

  it("accepts nullable visibility from GitHub", () => {
    const result = githubEmailListSchema.safeParse([
      { email: "user@example.com", primary: true, verified: true, visibility: null },
    ]);

    expect(result.success).toBe(true);
  });

  it("rejects malformed or partial email responses", () => {
    expect(githubEmailListSchema.safeParse({ email: "user@example.com" }).success).toBe(false);
    expect(
      githubEmailListSchema.safeParse([
        { email: "user@example.com", primary: true, verified: true },
      ]).success
    ).toBe(false);
    expect(
      githubEmailListSchema.safeParse([
        { email: "user@example.com", primary: true, verified: "yes", visibility: null },
      ]).success
    ).toBe(false);
  });
});

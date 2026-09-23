import { describe, expect, it } from "vitest";
import type { AgentResponse } from "@open-inspect/shared/types/artifacts";
import { MAX_MESSAGE_LENGTH } from "./discord-api";
import { formatCompletion } from "./format";
import { repoChoices, findRepo } from "./repos";
import { taskTitle } from "./task";

function response(overrides: Partial<AgentResponse> = {}): AgentResponse {
  return {
    textContent: "Made the icon black.",
    toolCalls: [],
    artifacts: [],
    mediaArtifacts: [],
    success: true,
    ...overrides,
  };
}

describe("formatCompletion", () => {
  it("mentions the user and includes the PR and summary", () => {
    const text = formatCompletion({
      userId: "u1",
      success: true,
      response: response({
        artifacts: [{ type: "pr", url: "https://github.com/o/r/pull/1" } as never],
      }),
      sessionUrl: "https://web/session/s1",
    });
    expect(text).toContain("✅ <@u1> task complete");
    expect(text).toContain("**Pull request:** https://github.com/o/r/pull/1");
    expect(text).toContain("Made the icon black.");
    expect(text).toContain("[View session](<https://web/session/s1>)");
  });

  it("reports the error on failure", () => {
    const text = formatCompletion({
      userId: "u1",
      success: false,
      error: "sandbox crashed",
      response: null,
      sessionUrl: "https://web/session/s1",
    });
    expect(text).toContain("⚠️ <@u1> task failed");
    expect(text).toContain("**Error:** sandbox crashed");
  });

  it("stays within Discord's length limit and keeps the session link", () => {
    const text = formatCompletion({
      userId: "u1",
      success: true,
      response: response({ textContent: "x".repeat(5000) }),
      sessionUrl: "https://web/session/s1",
    });
    expect(text.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
    expect(text.endsWith("[View session](<https://web/session/s1>)")).toBe(true);
  });
});

describe("repo helpers", () => {
  const repos = ["octo/website", "octo/tools", "acme/api"];

  it("matches any part of the name, case-insensitively", () => {
    expect(repoChoices(repos, "WEBS").map((choice) => choice.value)).toEqual(["octo/website"]);
    expect(repoChoices(repos, "")).toHaveLength(3);
  });

  it("resolves exact names only", () => {
    expect(findRepo(repos, "Octo/Tools")).toBe("octo/tools");
    expect(findRepo(repos, "tools")).toBeUndefined();
  });
});

describe("taskTitle", () => {
  it("uses the first line and truncates long titles", () => {
    expect(taskTitle("Fix the header\nmore detail")).toBe("Fix the header");
    expect(taskTitle("a".repeat(100))).toHaveLength(80);
  });
});

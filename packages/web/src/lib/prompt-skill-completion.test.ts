import { describe, expect, it } from "vitest";
import {
  applySkillCompletion,
  filterSkillSuggestions,
  findActiveSkillCompletion,
  type PromptSkillSuggestion,
} from "./prompt-skill-completion";

const skills: PromptSkillSuggestion[] = [
  { skillId: "1", name: "review-pr", description: "Review a pull request" },
  { skillId: "2", name: "release-notes", description: "Write release notes" },
];

describe("prompt skill completion", () => {
  it.each([
    ["/", 1, "/", ""],
    ["use $rev", 8, "$", "rev"],
    ["first\n/RELEASE", 14, "/", "release"],
  ] as const)("finds an active token in %j", (value, caret, trigger, query) => {
    expect(findActiveSkillCompletion(value, caret, caret)).toMatchObject({ trigger, query });
  });

  it.each([
    ["https://example.com/rev", 23, 23],
    ["cost$rev", 8, 8],
    ["use /rev!", 9, 9],
    ["use @rev", 8, 8],
  ] as const)("does not complete invalid token %j", (value, start, end) => {
    expect(findActiveSkillCompletion(value, start, end)).toBeNull();
  });

  it("includes the complete token when the caret moves into its middle", () => {
    expect(findActiveSkillCompletion("use $rev-old now", 8, 8)).toEqual({
      trigger: "$",
      query: "rev",
      start: 4,
      end: 12,
    });
  });

  it("filters by case-insensitive prefix without reordering", () => {
    const completion = findActiveSkillCompletion("$RE", 3, 3);
    expect(filterSkillSuggestions(skills, completion).map((skill) => skill.name)).toEqual([
      "review-pr",
      "release-notes",
    ]);
  });

  it("replaces the token and appends a space at the end of the prompt", () => {
    const value = "Please $rev";
    const completion = findActiveSkillCompletion(value, value.length, value.length)!;
    expect(applySkillCompletion(value, completion, "review-pr")).toEqual({
      value: "Please $review-pr ",
      caret: 18,
    });
  });

  it("preserves punctuation and surrounding text for an internal token", () => {
    const value = "Use /rev, then explain";
    const completion = findActiveSkillCompletion(value, 8, 8)!;
    expect(applySkillCompletion(value, completion, "review-pr")).toEqual({
      value: "Use /review-pr, then explain",
      caret: 14,
    });
  });

  it("refuses a replacement that exceeds the prompt limit", () => {
    const value = "$r";
    const completion = findActiveSkillCompletion(value, value.length, value.length)!;
    expect(applySkillCompletion(value, completion, "review-pr", 5)).toBeNull();
    expect(applySkillCompletion(value, completion, "review-pr", 11)?.value).toBe("$review-pr ");
  });
});

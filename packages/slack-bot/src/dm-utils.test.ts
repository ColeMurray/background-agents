import { describe, expect, it } from "vitest";
import { startsWithUserMention } from "./dm-utils";

describe("startsWithUserMention", () => {
  it.each([
    ["<@U555> can you look?", true],
    ["  <@U555> can you look?", true],
    ["<@U555|alice> can you look?", true],
    ["<@U555>", true],
    ["can you look <@U555>?", false],
    ["<!here> can you look?", false],
    ["can you look?", false],
  ])("%j → %s", (text, expected) => {
    expect(startsWithUserMention(text)).toBe(expected);
  });
});

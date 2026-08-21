import { describe, expect, it } from "vitest";
import { parseSkillMarkdown, SkillMarkdownError } from "./skill-markdown";

function scalar(markdown: string, key: string): string | undefined {
  const value = parseSkillMarkdown(markdown).frontmatter.get(key);
  return value?.kind === "scalar" ? value.value : undefined;
}

describe("parseSkillMarkdown", () => {
  it("splits frontmatter from the body", () => {
    const parsed = parseSkillMarkdown(
      ["---", "name: deploy-service", "description: Deploys the API", "---", "# Deploy", ""].join(
        "\n"
      )
    );

    expect(parsed.frontmatter.get("name")).toEqual({ kind: "scalar", value: "deploy-service" });
    expect(parsed.frontmatter.get("description")).toEqual({
      kind: "scalar",
      value: "Deploys the API",
    });
    expect(parsed.body).toBe("# Deploy\n");
  });

  it("keeps colons and attached hashes inside plain scalars", () => {
    expect(scalar("---\ndescription: Use when: deploying issue#1\n---\n", "description")).toBe(
      "Use when: deploying issue#1"
    );
  });

  it("strips a trailing comment introduced by whitespace", () => {
    expect(scalar("---\nname: deploy # canonical\n---\n", "name")).toBe("deploy");
  });

  it("reads quoted scalars and their escapes", () => {
    expect(scalar('---\ndescription: "line\\none"\n---\n', "description")).toBe("line\none");
    expect(scalar("---\ndescription: 'it''s here'\n---\n", "description")).toBe("it's here");
  });

  it("allows a comment after a quoted scalar", () => {
    expect(scalar('---\nname: "deploy" # canonical\n---\n', "name")).toBe("deploy");
    expect(scalar("---\nname: 'deploy'   # canonical\n---\n", "name")).toBe("deploy");
  });

  it("keeps commas and escaped quotes inside quoted flow entries", () => {
    expect(parseSkillMarkdown('---\ntools: ["a,b", c]\n---\n').frontmatter.get("tools")).toEqual({
      kind: "sequence",
      value: ["a,b", "c"],
    });
    expect(
      parseSkillMarkdown('---\ntools: ["say \\"hi\\"", c]\n---\n').frontmatter.get("tools")
    ).toEqual({ kind: "sequence", value: ['say "hi"', "c"] });
  });

  it("reads literal and folded block scalars", () => {
    expect(scalar("---\ndescription: |\n  first\n  second\n---\n", "description")).toBe(
      "first\nsecond\n"
    );
    expect(scalar("---\ndescription: >-\n  first\n  second\n---\n", "description")).toBe(
      "first second"
    );
  });

  it("folds an indented plain scalar continued across lines", () => {
    expect(scalar("---\ndescription:\n  first line\n  second line\n---\n", "description")).toBe(
      "first line second line"
    );
  });

  it("reads a nested string map", () => {
    const parsed = parseSkillMarkdown("---\nmetadata:\n  team: platform\n  tier: '1'\n---\n");

    expect(parsed.frontmatter.get("metadata")).toEqual({
      kind: "map",
      value: { team: "platform", tier: "1" },
    });
  });

  it("reads block and flow sequences", () => {
    expect(
      parseSkillMarkdown("---\ntools:\n  - read\n  - write\n---\n").frontmatter.get("tools")
    ).toEqual({ kind: "sequence", value: ["read", "write"] });
    expect(parseSkillMarkdown("---\ntools: [read, write]\n---\n").frontmatter.get("tools")).toEqual(
      {
        kind: "sequence",
        value: ["read", "write"],
      }
    );
  });

  it("ignores comments, blank lines, and a leading byte-order mark", () => {
    const parsed = parseSkillMarkdown("﻿---\n# a comment\n\nname: deploy\n---\nbody\n");

    expect(parsed.frontmatter.get("name")).toEqual({ kind: "scalar", value: "deploy" });
    expect(parsed.body).toBe("body\n");
  });

  it("accepts the ... document terminator", () => {
    expect(scalar("---\nname: deploy\n...\nbody\n", "name")).toBe("deploy");
  });

  it.each([
    ["no frontmatter", "# Deploy\n"],
    ["unclosed frontmatter", "---\nname: deploy\n"],
    ["duplicate key", "---\nname: a\nname: b\n---\n"],
    ["tab indentation", "---\nmetadata:\n\tteam: platform\n---\n"],
    ["anchors", "---\nname: &anchor deploy\n---\n"],
    ["inline maps", "---\nmetadata: {team: platform}\n---\n"],
    ["unterminated quotes", '---\nname: "deploy\n---\n'],
    ["deeper nesting", "---\nmetadata:\n  team:\n    name: platform\n---\n"],
    ["mixed sequence and map", "---\ntools:\n  - read\n  write: yes\n---\n"],
    ["a code point above the Unicode range", '---\nname: "\\U0011FFFF"\n---\n'],
    ["a lone surrogate escape", '---\nname: "\\uD800"\n---\n'],
    ["text after a quoted scalar", '---\nname: "deploy" trailing\n---\n'],
    ["the keep chomping indicator", "---\ndescription: |+\n  text\n---\n"],
  ])("rejects %s", (_case, markdown) => {
    expect(() => parseSkillMarkdown(markdown)).toThrow(SkillMarkdownError);
  });
});

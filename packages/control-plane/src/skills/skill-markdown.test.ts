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

  it("keeps legal colons and attached hashes inside plain scalars", () => {
    expect(scalar("---\ndescription: Use when:deploying issue#1\n---\n", "description")).toBe(
      "Use when:deploying issue#1"
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

  it("allows a comment after a flow sequence", () => {
    expect(
      parseSkillMarkdown("---\ntools: [shell, git] # supported\n---\n").frontmatter.get("tools")
    ).toEqual({ kind: "sequence", value: ["shell", "git"] });
  });

  it("keeps a bracket inside a quoted entry from ending the sequence", () => {
    expect(
      parseSkillMarkdown('---\ntools: ["a]b", c] # note\n---\n').frontmatter.get("tools")
    ).toEqual({ kind: "sequence", value: ["a]b", "c"] });
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
    expect(scalar("---\ndescription: >\n  first\n\n  second\n---\n", "description")).toBe(
      "first\nsecond\n"
    );
    expect(scalar("---\ndescription: >\n  text\n    code\n  text\n---\n", "description")).toBe(
      "text\n  code\ntext\n"
    );
  });

  it("folds an indented plain scalar continued across lines", () => {
    expect(scalar("---\ndescription:\n  first line\n  second line\n---\n", "description")).toBe(
      "first line second line"
    );
  });

  it("reads a nested string map", () => {
    const parsed = parseSkillMarkdown("---\nmetadata:\n  team owner: platform\n  tier: '1'\n---\n");

    expect(parsed.frontmatter.get("metadata")).toEqual({
      kind: "map",
      value: { "team owner": "platform", tier: "1" },
    });
  });

  it("preserves unsupported nested extension values for importer warnings", () => {
    const parsed = parseSkillMarkdown(
      "---\ndescription: Deploys the API\nextension:\n  permissions:\n    - deploy\n---\n"
    );

    expect(parsed.frontmatter.get("extension")).toEqual({ kind: "unsupported" });
  });

  it("reads an inline string map", () => {
    expect(
      parseSkillMarkdown("---\nmetadata: {team: platform}\n---\n").frontmatter.get("metadata")
    ).toEqual({ kind: "map", value: { team: "platform" } });
  });

  it("uses the failsafe schema so scalar-looking values stay strings", () => {
    expect(scalar("---\nvalue: true\n---\n", "value")).toBe("true");
    expect(scalar("---\nvalue: 123\n---\n", "value")).toBe("123");
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
    ["aliases", "---\nname: &anchor deploy\nother: *anchor\n---\n"],
    ["custom tags", "---\nname: !custom deploy\n---\n"],
    ["a non-map root", "---\n- deploy\n---\n"],
    ["unterminated quotes", '---\nname: "deploy\n---\n'],
    ["mixed sequence and map", "---\ntools:\n  - read\n  write: yes\n---\n"],
    ["a code point above the Unicode range", '---\nname: "\\U0011FFFF"\n---\n'],
    ["a lone surrogate escape", '---\nname: "\\uD800"\n---\n'],
    ["text after a quoted scalar", '---\nname: "deploy" trailing\n---\n'],
    ["text after a flow sequence", "---\ntools: [shell] trailing\n---\n"],
    ["an unterminated flow sequence", "---\ntools: [shell, git\n---\n"],
  ])("rejects %s", (_case, markdown) => {
    expect(() => parseSkillMarkdown(markdown)).toThrow(SkillMarkdownError);
  });
});

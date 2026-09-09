/**
 * Reader for the YAML frontmatter in portable `SKILL.md` files.
 *
 * The YAML parser owns syntax and scalar folding. This module owns the much
 * smaller product policy: string scalars, flat string maps and string lists;
 * no aliases, anchors, custom tags or deeper nesting.
 */

import { isAlias, isMap, isNode, isScalar, isSeq, parseDocument, type Node } from "yaml";

/** A frontmatter entry, in the shapes the importer can map or report. */
type SkillFrontmatterValue =
  | { kind: "scalar"; value: string }
  | { kind: "map"; value: Record<string, string> }
  | { kind: "sequence"; value: string[] }
  | { kind: "unsupported" };

export interface ParsedSkillMarkdown {
  frontmatter: Map<string, SkillFrontmatterValue>;
  body: string;
}

export class SkillMarkdownError extends Error {}

const FRONTMATTER_FENCE = /^(?:---|\.\.\.)\s*$/;

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function nodeLabel(path: string): string {
  return path ? `frontmatter "${path}"` : "frontmatter";
}

function hasWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** Reject YAML graph and tag features before reading a node's value. */
function assertPlainNode(node: Node, path: string): void {
  if (isAlias(node)) {
    throw new SkillMarkdownError(`YAML aliases are not supported in ${nodeLabel(path)}`);
  }
  if ("anchor" in node && node.anchor) {
    throw new SkillMarkdownError(`YAML anchors are not supported in ${nodeLabel(path)}`);
  }
  if (node.tag) {
    throw new SkillMarkdownError(`YAML tags are not supported in ${nodeLabel(path)}`);
  }
}

function stringScalar(value: unknown, path: string): string {
  if (!isNode(value)) throw new SkillMarkdownError(`${nodeLabel(path)} must not be empty`);
  const node: Node = value;
  assertPlainNode(node, path);
  if (!isScalar(node) || typeof node.value !== "string") {
    throw new SkillMarkdownError(`${nodeLabel(path)} must be a string`);
  }
  if (!hasWellFormedUnicode(node.value)) {
    throw new SkillMarkdownError(`${nodeLabel(path)} must contain valid Unicode`);
  }
  return node.value;
}

function keyScalar(node: unknown, path: string): string {
  return stringScalar(node, path);
}

/** Validate graph/tag and Unicode safety even for values the importer ignores. */
function assertPlainTree(value: unknown, path: string): void {
  if (!isNode(value)) return;
  const node: Node = value;
  assertPlainNode(node, path);
  if (isScalar(node)) {
    if (typeof node.value === "string" && !hasWellFormedUnicode(node.value)) {
      throw new SkillMarkdownError(`${nodeLabel(path)} must contain valid Unicode`);
    }
    return;
  }
  if (isSeq(node)) {
    node.items.forEach((item, index) => assertPlainTree(item, `${path}[${index}]`));
    return;
  }
  if (isMap(node)) {
    node.items.forEach((pair) => {
      const childKey = keyScalar(pair.key, path);
      assertPlainTree(pair.value, path ? `${path}.${childKey}` : childKey);
    });
  }
}

function frontmatterValue(value: unknown, key: string): SkillFrontmatterValue {
  if (!isNode(value)) throw new SkillMarkdownError(`${nodeLabel(key)} must not be empty`);
  const node: Node = value;
  assertPlainNode(node, key);
  if (isScalar(node)) return { kind: "scalar", value: stringScalar(node, key) };
  if (isSeq(node)) {
    if (!node.items.every((item) => isScalar(item) && typeof item.value === "string")) {
      assertPlainTree(node, key);
      return { kind: "unsupported" };
    }
    return {
      kind: "sequence",
      value: node.items.map((item, index) => stringScalar(item, `${key}[${index}]`)),
    };
  }
  if (isMap(node)) {
    if (!node.items.every((pair) => isScalar(pair.value) && typeof pair.value.value === "string")) {
      assertPlainTree(node, key);
      return { kind: "unsupported" };
    }
    const entries = node.items.map((pair) => {
      const childKey = keyScalar(pair.key, key);
      return [childKey, stringScalar(pair.value, `${key}.${childKey}`)] as const;
    });
    return { kind: "map", value: Object.fromEntries(entries) };
  }
  return { kind: "unsupported" };
}

/** Split a `SKILL.md` into validated frontmatter entries and its Markdown body. */
export function parseSkillMarkdown(markdown: string): ParsedSkillMarkdown {
  const lines = stripBom(markdown).split("\n");
  if (!/^---\s*$/.test(lines[0] ?? "")) {
    throw new SkillMarkdownError("SKILL.md must start with a --- frontmatter block");
  }
  const closingIndex = lines.findIndex((line, index) => index > 0 && FRONTMATTER_FENCE.test(line));
  if (closingIndex === -1) {
    throw new SkillMarkdownError("SKILL.md frontmatter block is not closed");
  }

  const document = parseDocument(lines.slice(1, closingIndex).join("\n"), {
    schema: "failsafe",
    uniqueKeys: true,
    strict: true,
  });
  const problem = document.errors[0] ?? document.warnings[0];
  if (problem) throw new SkillMarkdownError(problem.message);
  if (!document.contents || !isMap(document.contents)) {
    throw new SkillMarkdownError("SKILL.md frontmatter must be a map");
  }

  assertPlainNode(document.contents, "");
  const frontmatter = new Map<string, SkillFrontmatterValue>();
  for (const pair of document.contents.items) {
    const key = keyScalar(pair.key, "");
    frontmatter.set(key, frontmatterValue(pair.value, key));
  }
  return { frontmatter, body: lines.slice(closingIndex + 1).join("\n") };
}

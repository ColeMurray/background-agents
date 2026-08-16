/**
 * Reader for the `SKILL.md` files that portable skill directories ship.
 *
 * Deliberately not a YAML implementation: managed-skill fields are bounded
 * strings and a string map, so this accepts the frontmatter subset that maps
 * onto them and refuses everything else by name. Anchors, aliases, tags, and
 * arbitrary nesting are rejected rather than half-supported, which keeps the
 * imported bytes and the stored fields easy to reason about.
 */

/** A frontmatter entry, in the shapes this reader can distinguish. */
export type SkillFrontmatterValue =
  | { kind: "scalar"; value: string }
  | { kind: "map"; value: Record<string, string> }
  | { kind: "sequence"; value: string[] };

export interface ParsedSkillMarkdown {
  frontmatter: Map<string, SkillFrontmatterValue>;
  body: string;
}

export class SkillMarkdownError extends Error {}

const KEY_PATTERN = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:(?:\s+(.*))?$/;
const FRONTMATTER_FENCE = /^(?:---|\.\.\.)\s*$/;

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function indentWidth(line: string): number {
  return line.length - line.trimStart().length;
}

function isBlankOrComment(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith("#");
}

/**
 * Strip an inline comment from a plain (unquoted) scalar. YAML only starts a
 * comment at ` #`, so `a#b` stays intact.
 */
function stripInlineComment(value: string): string {
  const index = value.search(/\s#/);
  return (index === -1 ? value : value.slice(0, index)).trim();
}

function unescapeDoubleQuoted(raw: string, line: number): string {
  let result = "";
  for (let index = 0; index < raw.length; index++) {
    const character = raw[index];
    if (character !== "\\") {
      result += character;
      continue;
    }
    const escape = raw[++index];
    if (escape === undefined) throw new SkillMarkdownError(`unterminated escape on line ${line}`);
    if (escape === "n") result += "\n";
    else if (escape === "t") result += "\t";
    else if (escape === "r") result += "\r";
    else if (escape === "0") result += "\0";
    else if (escape === "u" || escape === "U") {
      const width = escape === "u" ? 4 : 8;
      const digits = raw.slice(index + 1, index + 1 + width);
      if (!new RegExp(`^[0-9a-fA-F]{${width}}$`).test(digits)) {
        throw new SkillMarkdownError(`invalid unicode escape on line ${line}`);
      }
      result += String.fromCodePoint(Number.parseInt(digits, 16));
      index += width;
    } else if (escape === '"' || escape === "\\" || escape === "/") result += escape;
    else throw new SkillMarkdownError(`unsupported escape \\${escape} on line ${line}`);
  }
  return result;
}

/** Read one inline scalar, rejecting flow maps and multi-document markers. */
function parseInlineScalar(raw: string, line: number): string {
  const value = raw.trim();
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2) {
      throw new SkillMarkdownError(`unterminated quoted value on line ${line}`);
    }
    return unescapeDoubleQuoted(value.slice(1, -1), line);
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) {
      throw new SkillMarkdownError(`unterminated quoted value on line ${line}`);
    }
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.startsWith("{")) {
    throw new SkillMarkdownError(`inline maps are not supported (line ${line})`);
  }
  if (value.startsWith("&") || value.startsWith("*") || value.startsWith("!")) {
    throw new SkillMarkdownError(
      `YAML anchors, aliases, and tags are not supported (line ${line})`
    );
  }
  return stripInlineComment(value);
}

function parseFlowSequence(raw: string, line: number): string[] {
  const inner = raw.trim().slice(1, -1).trim();
  if (inner === "") return [];
  return inner.split(",").map((entry) => parseInlineScalar(entry, line));
}

/**
 * Read a `|`/`>` block scalar. Only the clip and strip chomping indicators are
 * accepted; explicit indentation indicators are not.
 */
function parseBlockScalar(
  header: string,
  lines: string[],
  start: number,
  line: number
): { value: string; next: number } {
  const match = /^([|>])([-+]?)$/.exec(header.trim());
  if (!match) throw new SkillMarkdownError(`unsupported block scalar header on line ${line}`);
  const [, style, chomping] = match;
  const collected: string[] = [];
  let index = start;
  let blockIndent: number | null = null;
  for (; index < lines.length; index++) {
    const current = lines[index];
    if (FRONTMATTER_FENCE.test(current)) break;
    if (current.trim() === "") {
      collected.push("");
      continue;
    }
    const indent = indentWidth(current);
    if (indent === 0) break;
    if (blockIndent === null) blockIndent = indent;
    if (indent < blockIndent) break;
    collected.push(current.slice(blockIndent));
  }
  while (collected.length > 0 && collected[collected.length - 1] === "") collected.pop();
  let value: string;
  if (style === "|") {
    value = collected.join("\n");
  } else {
    value = collected.reduce((folded, current, position) => {
      if (position === 0) return current;
      const separator = current === "" || collected[position - 1] === "" ? "\n" : " ";
      return folded + separator + current;
    }, "");
  }
  if (chomping !== "-" && value !== "") value += "\n";
  return { value, next: index };
}

/**
 * Read the indented block under a key. Its first line decides the shape: a
 * `- ` item makes a sequence, a `key: value` line makes a string map, and
 * anything else is a plain scalar continued across lines and folded on
 * spaces, which is how a long `description` is usually written.
 */
function parseNestedBlock(
  lines: string[],
  start: number,
  parentLine: number
): { value: SkillFrontmatterValue; next: number } {
  const block: { text: string; line: number }[] = [];
  let index = start;
  let blockIndent: number | null = null;
  for (; index < lines.length; index++) {
    const current = lines[index];
    if (FRONTMATTER_FENCE.test(current)) break;
    if (isBlankOrComment(current)) continue;
    const indent = indentWidth(current);
    if (indent === 0) break;
    if (current.slice(0, indent).includes("\t")) {
      throw new SkillMarkdownError(`tab indentation is not supported (line ${index + 1})`);
    }
    if (blockIndent === null) blockIndent = indent;
    if (indent < blockIndent) break;
    if (indent > blockIndent) {
      throw new SkillMarkdownError(`nested structures are not supported (line ${index + 1})`);
    }
    block.push({ text: current.trim(), line: index + 1 });
  }
  if (block.length === 0) throw new SkillMarkdownError(`empty value on line ${parentLine}`);

  const first = block[0].text;
  if (first.startsWith("- ") || first === "-") {
    return {
      value: {
        kind: "sequence",
        value: block.map((entry) => {
          if (!entry.text.startsWith("- ") && entry.text !== "-") {
            throw new SkillMarkdownError(`mixed map and sequence entries (line ${entry.line})`);
          }
          return parseInlineScalar(entry.text.slice(1), entry.line);
        }),
      },
      next: index,
    };
  }
  if (KEY_PATTERN.test(first)) {
    const entries: [string, string][] = [];
    for (const entry of block) {
      const match = KEY_PATTERN.exec(entry.text);
      if (!match) throw new SkillMarkdownError(`unsupported frontmatter line ${entry.line}`);
      const [, key, rawValue] = match;
      if (rawValue === undefined) {
        throw new SkillMarkdownError(`nested structures are not supported (line ${entry.line})`);
      }
      if (entries.some(([existing]) => existing === key)) {
        throw new SkillMarkdownError(`duplicate key "${key}" on line ${entry.line}`);
      }
      entries.push([key, parseInlineScalar(rawValue, entry.line)]);
    }
    return { value: { kind: "map", value: Object.fromEntries(entries) }, next: index };
  }
  return {
    value: { kind: "scalar", value: block.map((entry) => entry.text).join(" ") },
    next: index,
  };
}

/**
 * Split a `SKILL.md` into frontmatter entries and the Markdown body.
 *
 * @throws SkillMarkdownError when the document has no frontmatter or uses YAML
 *   this reader deliberately does not accept.
 */
export function parseSkillMarkdown(markdown: string): ParsedSkillMarkdown {
  const text = stripBom(markdown);
  const lines = text.split("\n");
  if (!/^---\s*$/.test(lines[0] ?? "")) {
    throw new SkillMarkdownError("SKILL.md must start with a --- frontmatter block");
  }
  const frontmatter = new Map<string, SkillFrontmatterValue>();
  let index = 1;
  let closed = false;
  while (index < lines.length) {
    const current = lines[index];
    if (FRONTMATTER_FENCE.test(current)) {
      closed = true;
      index++;
      break;
    }
    if (isBlankOrComment(current)) {
      index++;
      continue;
    }
    if (indentWidth(current) > 0) {
      throw new SkillMarkdownError(`unexpected indentation on line ${index + 1}`);
    }
    const match = KEY_PATTERN.exec(current);
    if (!match) throw new SkillMarkdownError(`unsupported frontmatter line ${index + 1}`);
    const [, key, rawValue] = match;
    if (frontmatter.has(key)) {
      throw new SkillMarkdownError(`duplicate key "${key}" on line ${index + 1}`);
    }
    const lineNumber = index + 1;
    const trimmedValue = rawValue?.trim() ?? "";
    if (trimmedValue === "" || trimmedValue.startsWith("#")) {
      const nested = parseNestedBlock(lines, index + 1, lineNumber);
      frontmatter.set(key, nested.value);
      index = nested.next;
      continue;
    }
    if (/^[|>]/.test(trimmedValue)) {
      const block = parseBlockScalar(trimmedValue, lines, index + 1, lineNumber);
      frontmatter.set(key, { kind: "scalar", value: block.value });
      index = block.next;
      continue;
    }
    if (trimmedValue.startsWith("[")) {
      if (!trimmedValue.endsWith("]")) {
        throw new SkillMarkdownError(`unterminated list on line ${lineNumber}`);
      }
      frontmatter.set(key, {
        kind: "sequence",
        value: parseFlowSequence(trimmedValue, lineNumber),
      });
      index++;
      continue;
    }
    frontmatter.set(key, { kind: "scalar", value: parseInlineScalar(trimmedValue, lineNumber) });
    index++;
  }
  if (!closed) throw new SkillMarkdownError("SKILL.md frontmatter block is not closed");
  return { frontmatter, body: lines.slice(index).join("\n") };
}

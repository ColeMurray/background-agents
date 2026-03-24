/**
 * Minimal glob matching for branch patterns and file path globs.
 *
 * Supports:
 * - `*` matches any characters within a single path segment (no `/`)
 * - `**` matches zero or more path segments (including `/`)
 * - Literal characters match exactly (case-sensitive)
 */

export function matchGlob(pattern: string, input: string): boolean {
  return globToRegex(pattern).test(input);
}

function globToRegex(pattern: string): RegExp {
  let regex = "^";
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === "*" && pattern[i + 1] === "*") {
      regex += ".*";
      i += 2;
      if (pattern[i] === "/") i++; // skip trailing slash after **
    } else if (pattern[i] === "*") {
      regex += "[^/]*";
      i++;
    } else {
      regex += escapeRegex(pattern[i]);
      i++;
    }
  }
  regex += "$";
  return new RegExp(regex);
}

function escapeRegex(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

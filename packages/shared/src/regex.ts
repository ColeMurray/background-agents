/**
 * Escape a string so it can be embedded literally inside a `RegExp`. Every
 * regex-special character is backslash-escaped so the value matches itself.
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

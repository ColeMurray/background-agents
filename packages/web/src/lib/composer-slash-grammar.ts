export interface SlashTokenContext {
  start: number;
  end: number;
  query: string;
  token: string;
}

const LEFT_CONTEXT_PATTERN = /(?:^|[\s([{"'])\/[A-Za-z0-9_-]*$/;
const TOKEN_CHAR_PATTERN = /[A-Za-z0-9_-]/;

export function getSlashTokenContext(text: string, caretIndex: number): SlashTokenContext | null {
  const boundedCaret = Math.max(0, Math.min(caretIndex, text.length));
  const left = text.slice(0, boundedCaret);
  const match = left.match(LEFT_CONTEXT_PATTERN);

  if (!match) return null;

  const matched = match[0];
  const hasLeadingBoundary = matched[0] !== "/";
  const start = boundedCaret - matched.length + (hasLeadingBoundary ? 1 : 0);

  if (start < 0 || text[start] !== "/") return null;

  let end = boundedCaret;
  while (end < text.length && TOKEN_CHAR_PATTERN.test(text[end])) {
    end += 1;
  }

  const token = text.slice(start, end);
  if (!token.startsWith("/")) return null;

  const query = text.slice(start + 1, boundedCaret);
  return { start, end, query, token };
}

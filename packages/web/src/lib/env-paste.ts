export type ParsedEnvEntry = {
  key: string;
  value: string;
};

const ENV_LINE_REGEX = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

export function normalizeKey(value: string): string {
  return value.trim().toUpperCase();
}

export function parseMaybeEnvContent(content: string): ParsedEnvEntry[] {
  const normalizedContent = content.replace(/\r\n?/g, "\n");
  const parsed: ParsedEnvEntry[] = [];

  for (const rawLine of normalizedContent.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const match = line.match(ENV_LINE_REGEX);
    if (!match) {
      continue;
    }

    const key = match[1];
    let value = match[2].trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    parsed.push({ key: normalizeKey(key), value });
  }

  if (parsed.length === 0) {
    return [];
  }

  const deduped = new Map<string, ParsedEnvEntry>();
  for (const entry of parsed) {
    deduped.set(entry.key, entry);
  }

  return Array.from(deduped.values());
}

export interface CreatedAtIdCursor {
  createdAt: number;
  id: string;
}

export function encodeCreatedAtIdCursor(cursor: CreatedAtIdCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  const encoded = btoa(String.fromCharCode(...bytes));
  return encoded.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function parseCreatedAtIdCursor(raw: string | null): CreatedAtIdCursor | null {
  if (raw === null) return null;
  try {
    const base64 = raw.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    const value = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)))
    ) as Partial<CreatedAtIdCursor>;
    return Number.isSafeInteger(value.createdAt) &&
      value.createdAt! >= 0 &&
      typeof value.id === "string" &&
      value.id.length > 0
      ? { createdAt: value.createdAt!, id: value.id }
      : null;
  } catch {
    return null;
  }
}

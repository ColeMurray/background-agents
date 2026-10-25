export interface MermaidImage {
  src: string;
  width: number;
  height: number;
}

export const MAX_MERMAID_SOURCE_LENGTH = 20_000;
export const MERMAID_RENDER_TIMEOUT_MS = 15_000;

export function isMermaidImage(value: unknown): value is MermaidImage {
  return (
    typeof value === "object" &&
    value !== null &&
    "src" in value &&
    typeof value.src === "string" &&
    value.src.startsWith("data:image/svg+xml;charset=utf-8,") &&
    "width" in value &&
    typeof value.width === "number" &&
    Number.isFinite(value.width) &&
    value.width > 0 &&
    "height" in value &&
    typeof value.height === "number" &&
    Number.isFinite(value.height) &&
    value.height > 0
  );
}

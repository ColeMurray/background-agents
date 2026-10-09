import { open, type FileHandle } from "node:fs/promises";

/** How much of the Next log a diagnostic keeps. */
const LOG_TAIL_CHARS = 12_000;

/** Keep the primary failure and cleanup causes, without dumping request objects or stacks. */
export function errorSummary(error: unknown, depth = 0): string {
  if (!(error instanceof Error)) return "Unknown preview failure";
  const children = depth < 4 && error instanceof AggregateError ? error.errors : [];
  return [error.message, ...children.map((child) => errorSummary(child, depth + 1))].join("\n");
}

export function sanitizedDiagnostic(
  error: unknown,
  log: string,
  secrets: Iterable<string>
): string {
  let text = `${errorSummary(error)}\n\nNext log (bounded tail):\n${log.slice(-LOG_TAIL_CHARS)}`;
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length))
    text = text.replaceAll(secret, "[redacted]");
  return text
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(/-----BEGIN[^-]+-----[\s\S]*?-----END[^-]+-----/g, "[redacted key]");
}

/**
 * The end of a log, read without loading the whole file: a long-running Next log can grow large and
 * only its tail is kept. Empty when the log cannot be read.
 */
export async function readLogTail(path: string): Promise<string> {
  // No character takes more than four UTF-8 bytes, so this window always holds the kept tail.
  const maxBytes = LOG_TAIL_CHARS * 4;
  let file: FileHandle | undefined;
  try {
    file = await open(path);
    const { size } = await file.stat();
    const length = Math.min(size, maxBytes);
    const { buffer, bytesRead } = await file.read(Buffer.alloc(length), 0, length, size - length);
    return buffer.toString("utf8", 0, bytesRead);
  } catch {
    return "";
  } finally {
    await file?.close().catch(() => undefined);
  }
}

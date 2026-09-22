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
  let text = `${errorSummary(error)}\n\nNext log (bounded tail):\n${log.slice(-12_000)}`;
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length))
    text = text.replaceAll(secret, "[redacted]");
  return text
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(/-----BEGIN[^-]+-----[\s\S]*?-----END[^-]+-----/g, "[redacted key]");
}

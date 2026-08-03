export function formatReadyDetails(
  buildSha: string | null | undefined,
  buildDurationSeconds: number | null | undefined
): string {
  const sha = buildSha ? buildSha.slice(0, 7) : "";
  const duration = buildDurationSeconds ? `${Math.round(buildDurationSeconds)}s` : "";
  return [sha, duration].filter(Boolean).join(" · ");
}

export function buildSessionMediaUrl(sessionId: string, artifactId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/media/${encodeURIComponent(artifactId)}`;
}

/** Explicit prompt references, never arbitrary pasted conversation bodies. */
const referencePattern = /#\[([^\]\n]{1,100})\]\(session:([a-zA-Z0-9_-]{1,100})\)/g;
export function sessionReferences(
  content: string
): { id: string; label: string; marker: string }[] {
  return [...content.matchAll(referencePattern)].map((match) => ({
    id: match[2],
    label: match[1],
    marker: match[0],
  }));
}
export function referenceMarker(id: string, label: string): string {
  return `#[${label.replace(/[\]\n]/g, " ").slice(0, 100) || id}](session:${id})`;
}
export interface SessionReferenceSummary {
  id: string;
  title: string | null;
  target: string;
  status: string;
  project: { id: string; name: string } | null;
  pullRequests: { url: string; state: string }[];
  finalAssistantExcerpt: string;
}
export function boundedSessionReference(input: SessionReferenceSummary): SessionReferenceSummary {
  const result: SessionReferenceSummary = {
    id: input.id,
    title: input.title?.slice(0, 200) ?? null,
    target: input.target.slice(0, 400),
    status: input.status,
    project: input.project
      ? { id: input.project.id, name: input.project.name.slice(0, 100) }
      : null,
    pullRequests: input.pullRequests.map(({ url, state }) => ({ url: url.slice(0, 2048), state })),
    finalAssistantExcerpt: input.finalAssistantExcerpt.slice(0, 2000),
  };
  while (JSON.stringify(result).length > 4000 && result.pullRequests.length)
    result.pullRequests.pop();
  while (JSON.stringify(result).length > 4000 && result.finalAssistantExcerpt.length)
    result.finalAssistantExcerpt = result.finalAssistantExcerpt.slice(
      0,
      Math.floor(result.finalAssistantExcerpt.length / 2)
    );
  return result;
}

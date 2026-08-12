export function parseSessionTitlePatchBody(body: unknown): { title?: string } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;

  const title = (body as { title?: unknown }).title;
  if (title !== undefined && typeof title !== "string") return null;

  return { title };
}

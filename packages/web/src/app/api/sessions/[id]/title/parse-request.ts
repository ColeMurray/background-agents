export function parseSessionTitlePatchBody(body: unknown): { title?: string } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;

  const title = "title" in body ? body.title : undefined;
  if (title !== undefined && typeof title !== "string") return null;

  return { title };
}

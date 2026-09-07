export type PrerequisiteStatus = "loading" | "ready" | "unavailable";

/** Failed revalidation is not authoritative, even when cached data is available. */
export function getPrerequisiteStatus(
  data: unknown,
  loading: boolean,
  error: unknown
): PrerequisiteStatus {
  if (error) return "unavailable";
  if (loading) return "loading";
  return data === undefined ? "unavailable" : "ready";
}

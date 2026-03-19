const ALLOWED_CONTROL_PLANE_QUERY_PARAMS = ["status", "limit", "offset"] as const;

export function buildControlPlanePath(basePath: string, searchParams: URLSearchParams): string {
  const forwardedSearchParams = new URLSearchParams();

  for (const key of ALLOWED_CONTROL_PLANE_QUERY_PARAMS) {
    const value = searchParams.get(key);

    if (value !== null) {
      forwardedSearchParams.set(key, value);
    }
  }

  const queryString = forwardedSearchParams.toString();
  return queryString ? `${basePath}?${queryString}` : basePath;
}

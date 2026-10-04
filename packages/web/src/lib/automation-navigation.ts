/**
 * Entry-page team scope from `?teamId=`. The API's workspace-only `null` filter is not a
 * team, so it (like an absent value) means unscoped navigation.
 */
export function automationScopeTeamId(value: string | null): string | undefined {
  return value && value !== "null" ? value : undefined;
}

/** Entry-page scope is independent of the resource owner or create-form selection. */
export function automationNavigation(teamId?: string | null) {
  const withScope = (path: string, query: Record<string, string> = {}) => {
    const params = new URLSearchParams(query);
    if (teamId) params.set("teamId", teamId);
    const search = params.toString();
    return search ? `${path}?${search}` : path;
  };
  return {
    list: withScope("/automations"),
    detail: (id: string) => withScope(`/automations/${encodeURIComponent(id)}`),
    edit: (id: string) => withScope(`/automations/${encodeURIComponent(id)}/edit`),
    templates: withScope("/automations/templates"),
    new: (templateId?: string) =>
      withScope("/automations/new", templateId ? { template: templateId } : {}),
  };
}

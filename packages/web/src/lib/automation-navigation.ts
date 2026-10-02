/**
 * Entry-page team scope from `?teamId=`. The API's workspace-only `null` filter is not a
 * team, so it (like an absent value) means unscoped navigation.
 */
export function automationScopeTeamId(value: string | null): string | undefined {
  return value && value !== "null" ? value : undefined;
}

/** Entry-page scope is independent of the resource owner or create-form selection. */
export function automationNavigation(teamId?: string | null) {
  const scopeQuery = teamId ? `?teamId=${encodeURIComponent(teamId)}` : "";
  return {
    list: `/automations${scopeQuery}`,
    detail: (id: string) => `/automations/${encodeURIComponent(id)}${scopeQuery}`,
    edit: (id: string) => `/automations/${encodeURIComponent(id)}/edit${scopeQuery}`,
    templates: `/automations/templates${scopeQuery}`,
    new: (templateId?: string) =>
      templateId
        ? `/automations/new?template=${encodeURIComponent(templateId)}${teamId ? `&teamId=${encodeURIComponent(teamId)}` : ""}`
        : `/automations/new${scopeQuery}`,
  };
}

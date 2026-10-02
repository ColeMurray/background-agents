import { test, expect } from "@playwright/test";
import { PERMISSION_IDS } from "../../shared/src/rbac";
import type { ProjectView } from "@open-inspect/shared/types/projects";

/** Browser contracts use fixture APIs. Backend semantics are covered by projects.test.ts in workerd. */
test("curate a project and associate a session tree without losing the brief", async ({ page }) => {
  const userId = "11111111111111111111111111111111";
  let project: ProjectView | undefined;
  const pins: Record<string, unknown>[] = [];
  const sources: Record<string, unknown>[] = [];
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const reply = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (path === "/api/auth/get-session")
      return reply({
        user: { id: userId, name: "Project tester" },
        session: { id: "browser", userId, expiresAt: "2030-01-01T00:00:00Z" },
      });
    if (path === "/api/me/authorization")
      return reply({
        userId,
        suspendedAt: null,
        role: { id: "role_builtin_owner", key: "owner", name: "Owner" },
        permissions: PERMISSION_IDS,
      });
    if (path === "/api/me/teams") return reply({ teams: [], requireTeamOnCreate: false });
    if (path === "/api/teams") return reply({ teams: [] });
    if (path === "/api/environments") return reply({ environments: [] });
    if (path === "/api/sessions/inbox")
      return reply({
        categories: Object.fromEntries(
          ["needs_attention", "in_progress", "finished"].map((category) => [
            category,
            { items: [], hasMore: false, nextCursor: null },
          ])
        ),
      });
    if (path === "/api/projects" && method === "POST") {
      const input = request.postDataJSON();
      project = {
        ...input,
        id: "proj_fixture",
        status: "active",
        ownerUserId: userId,
        brief: null,
        shippedAt: null,
        archivedAt: null,
        defaultEnvironmentId: null,
        defaultRepoOwner: null,
        defaultRepoName: null,
        defaultAgentProfileId: null,
        linearProjectId: null,
        linearProjectUrl: null,
        primarySlackChannelId: null,
        statusSummary: null,
        statusSummarySource: null,
        statusSummarySessionId: null,
        statusSummaryUpdatedAt: null,
        createdAt: 1,
        updatedAt: 1,
        capabilities: {
          canRead: true,
          canEditMetadata: true,
          canManageSources: true,
          canManagePins: true,
          canAssociateSessions: true,
          canSubscribeAutomations: true,
          canCreateStatusUpdate: false,
          canArchive: true,
        },
      };
      return reply({ project }, 201);
    }
    if (path === "/api/projects") return reply({ projects: project ? [project] : [] });
    if (path.startsWith("/api/projects/by-slug/")) return reply({ project });
    if (path === "/api/projects/proj_fixture" && method === "PATCH") {
      Object.assign(project!, request.postDataJSON());
      return reply({ project });
    }
    if (path.endsWith("/pins")) {
      if (method === "PUT")
        pins.push({ ...request.postDataJSON(), id: `pin_${pins.length}`, createdAt: 1 });
      return reply(method === "GET" ? { pins } : { id: "pin_0" });
    }
    if (path.endsWith("/sources")) {
      if (method === "PUT")
        sources.push({ ...request.postDataJSON(), id: `source_${sources.length}` });
      return reply(method === "GET" ? { sources } : { id: "source_0" });
    }
    if (path === "/api/projects/proj_fixture/status-summary") {
      Object.assign(project!, request.postDataJSON());
      return reply({ project });
    }
    if (path.endsWith("/sessions")) return reply({ items: [], hasMore: false });
    if (path.endsWith("/project") && method === "PUT") {
      writes.push({ path, body: request.postDataJSON() });
      return reply({ updated: 3, projectId: project?.id });
    }
    return reply({});
  });
  await page.goto("/projects");
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Billing migration");
  await page.getByLabel("Short name for the URL").fill("billing-migration");
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Billing migration", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByLabel("Brief", { exact: true })
    .fill("# Migration\nKeep dual writes until cutover.");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Migration", exact: true })).toBeVisible();
  await page.getByLabel("Pin title").fill("Dual write");
  await page.getByLabel("Decision", { exact: true }).fill("Do not remove legacy writes yet.");
  await page.getByRole("button", { name: "Add pin", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Dual write", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Sources", exact: true }).click();
  await page.getByLabel("Source reference").fill("https://linear.app/acme/project/billing");
  await page.getByRole("button", { name: "Add source", exact: true }).click();
  await expect(page.getByText("linear_project · reference · agent", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Sessions", exact: true }).click();
  await page.getByLabel("Existing session").fill("root-with-children");
  await page.getByRole("button", { name: "Add session", exact: true }).click();
  await expect
    .poll(() => writes)
    .toEqual([
      {
        path: "/api/sessions/root-with-children/project",
        body: { projectId: "proj_fixture", includeChildren: true },
      },
    ]);
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await expect(page.getByText("Keep dual writes until cutover.", { exact: true })).toBeVisible();
  await page.screenshot({
    path: "test-results/projects-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: /Toggle sidebar/ })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: "Billing migration", exact: true })).toBeVisible();
  await page.screenshot({
    path: "test-results/projects-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
});

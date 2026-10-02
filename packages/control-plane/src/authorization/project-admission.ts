import {
  canReadProject,
  projectCapabilities,
  type Project,
} from "@open-inspect/shared/types/projects";
import type { SessionViewer } from "@open-inspect/shared";
import { ProjectStore } from "../db/project-store";
import { json } from "../http/responses";
import type { RequestContext } from "../http/request-context";
import { resourceViewer } from "./resource-viewer";

export interface ProjectAdmission {
  project: Project;
  viewer: SessionViewer;
}
export async function evaluateProjectAdmission(
  ctx: RequestContext,
  id: string,
  need: "read" | "manage"
): Promise<ProjectAdmission | Response> {
  const project = await new ProjectStore(ctx.db).get(id);
  const viewer = await resourceViewer(ctx);
  if (!project || !canReadProject(viewer, project))
    return json({ error: "Project not found", code: "project_not_visible" }, 404);
  if (need === "manage" && !projectCapabilities(viewer, project).canEditMetadata)
    return json({ error: "Forbidden", code: "project_action_denied" }, 403);
  return { project, viewer };
}
export function admittedProject(ctx: RequestContext): ProjectAdmission {
  if (!ctx.projectAdmission) throw new Error("Route did not admit a project");
  return ctx.projectAdmission;
}

import { z } from "zod";
import { hasScopedPermission } from "../rbac";
import type { SessionViewer } from "./session-access";

export const PROJECT_STATUSES = ["active", "shipped", "archived"] as const;
export const projectStatusSchema = z.enum(PROJECT_STATUSES);
export const projectIdSchema = z.string().trim().min(1).max(100);
const text = (max: number) => z.string().trim().min(1).max(max);
const nullableText = (max: number) => z.string().max(max).nullable();
export const projectUrlSchema = z
  .url()
  .max(2048)
  .refine((url) => /^https?:\/\//i.test(url), "Use an HTTP or HTTPS URL");
const fields = {
  name: text(100),
  slug: text(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  brief: z.string().max(20_000).nullable(),
  defaultEnvironmentId: nullableText(100),
  defaultRepoOwner: nullableText(300),
  defaultRepoName: nullableText(100),
  defaultAgentProfileId: z.null(), // Reserved until the profile resolver exists.
  linearProjectId: nullableText(200),
  linearProjectUrl: projectUrlSchema.nullable(),
  primarySlackChannelId: text(100)
    .regex(/^[A-Z0-9]+$/)
    .nullable(),
};
export const createProjectSchema = z.strictObject({
  ...fields,
  brief: fields.brief.optional(),
  ownerTeamId: nullableText(100).optional(),
  defaultEnvironmentId: fields.defaultEnvironmentId.optional(),
  defaultRepoOwner: fields.defaultRepoOwner.optional(),
  defaultRepoName: fields.defaultRepoName.optional(),
  defaultAgentProfileId: fields.defaultAgentProfileId.optional(),
  linearProjectId: fields.linearProjectId.optional(),
  linearProjectUrl: fields.linearProjectUrl.optional(),
  primarySlackChannelId: fields.primarySlackChannelId.optional(),
});
export const updateProjectSchema = z.strictObject(fields).partial();
export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

export const projectSchema = z.object({
  ...fields,
  defaultRepoId: z.number().int().positive().nullable().optional(),
  id: projectIdSchema,
  ownerTeamId: z.string().nullable(),
  ownerUserId: z.string(),
  status: projectStatusSchema,
  shippedAt: z.number().nullable(),
  archivedAt: z.number().nullable(),
  statusSummary: z.string().nullable(),
  statusSummarySource: z.enum(["user", "agent"]).nullable(),
  statusSummarySessionId: z.string().nullable(),
  statusSummaryUpdatedAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Project = z.infer<typeof projectSchema>;
export type ProjectIdentity = Pick<Project, "ownerTeamId" | "ownerUserId">;

export function canReadProject(viewer: SessionViewer, project: ProjectIdentity): boolean {
  if (viewer.kind !== "user" || viewer.suspended || !viewer.permissions.includes("projects.read"))
    return false;
  return (
    project.ownerTeamId === null ||
    viewer.memberships.has(project.ownerTeamId) ||
    viewer.roleKey === "owner" ||
    viewer.roleKey === "administrator"
  );
}
export function projectCapabilities(viewer: SessionViewer, project: ProjectIdentity) {
  const canRead = canReadProject(viewer, project);
  const canManage =
    canRead &&
    viewer.kind === "user" &&
    hasScopedPermission(
      "projects.manage",
      viewer.permissions,
      project.ownerUserId === viewer.userId ||
        (project.ownerTeamId !== null && viewer.memberships.get(project.ownerTeamId) === "lead")
    );
  return {
    canRead,
    canEditMetadata: canManage,
    canManageSources: canManage,
    canManagePins: canManage,
    canAssociateSessions:
      canRead && viewer.kind === "user" && viewer.permissions.includes("sessions.lifecycle"),
    canSubscribeAutomations:
      canRead &&
      viewer.kind === "user" &&
      (viewer.permissions.includes("automations.manage.own") ||
        viewer.permissions.includes("automations.manage.any")),
    canCreateStatusUpdate: false,
    canArchive: canManage,
  };
}
export const projectCapabilitiesSchema = z.object({
  canRead: z.boolean(),
  canEditMetadata: z.boolean(),
  canManageSources: z.boolean(),
  canManagePins: z.boolean(),
  canAssociateSessions: z.boolean(),
  canSubscribeAutomations: z.boolean(),
  canCreateStatusUpdate: z.boolean(),
  canArchive: z.boolean(),
});
export const projectViewSchema = projectSchema.extend({
  openPrCount: z.number().int().nonnegative().optional(),
  lastActivityAt: z.number().optional(),
  capabilities: projectCapabilitiesSchema,
});
export type ProjectView = z.infer<typeof projectViewSchema>;

export const projectSourceInputSchema = z
  .strictObject({
    sourceType: z.enum(["linear_project", "slack_channel", "url", "repo_doc", "session", "memory"]),
    externalIdOrUrl: text(2048),
    title: nullableText(200).optional(),
    role: z.enum(["brief", "decisions", "tickets", "channel", "metrics", "reference"]),
    refreshPolicy: z.enum(["never", "manual", "on_session_create"]).default("never"),
    visibility: z.enum(["agent", "page_only"]).default("agent"),
    position: z.number().int().min(0).max(10_000).default(0),
  })
  .superRefine((value, ctx) => {
    if (value.sourceType === "url" && !projectUrlSchema.safeParse(value.externalIdOrUrl).success)
      ctx.addIssue({
        code: "custom",
        path: ["externalIdOrUrl"],
        message: "Use an HTTP or HTTPS URL",
      });
    if (value.sourceType === "memory")
      ctx.addIssue({ code: "custom", message: "Memory sources are not available yet" });
    if (value.sourceType === "repo_doc") {
      const match = /^([^:]+\/[^/:]+):([^\n]+)$/.exec(value.externalIdOrUrl);
      const path = match?.[2];
      if (
        !path ||
        path.startsWith("/") ||
        path.includes("\\") ||
        path.split("/").some((part) => part === ".." || part === "." || !part)
      )
        ctx.addIssue({
          code: "custom",
          message: "Use owner/repository:relative/path without traversal",
        });
    }
  });
export type ProjectSourceInput = z.infer<typeof projectSourceInputSchema>;
export interface ProjectSource extends ProjectSourceInput {
  id: string;
  projectId: string;
  provenance: "user" | "agent" | "import";
  provenanceSessionId: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}
export const projectPinInputSchema = z
  .strictObject({
    kind: z.enum(["decision", "link", "artifact"]),
    title: text(200),
    body: z.string().max(4000).nullable().optional(),
    url: projectUrlSchema.nullable().optional(),
    sessionId: projectIdSchema.nullable().optional(),
    artifactId: text(200).nullable().optional(),
    decidedAt: z.number().int().nonnegative().safe().nullable().optional(),
    position: z.number().int().min(0).max(10_000).default(0),
  })
  .superRefine((value, ctx) => {
    if (value.kind === "link" && !value.url)
      ctx.addIssue({ code: "custom", message: "A link needs a URL" });
    if (value.kind === "artifact" && (!value.sessionId || !value.artifactId))
      ctx.addIssue({ code: "custom", message: "An artifact needs sessionId and artifactId" });
    if (value.kind === "decision" && !value.decidedAt)
      ctx.addIssue({ code: "custom", message: "A decision needs decidedAt" });
  });
export type ProjectPinInput = z.infer<typeof projectPinInputSchema>;
export interface ProjectPin extends ProjectPinInput {
  id: string;
  projectId: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

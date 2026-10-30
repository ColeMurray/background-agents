import type { PersonalAccessTokenGrantablePermission } from "@open-inspect/shared/types/personal-access-tokens";

type PermissionGroup = "sessions" | "automations" | "skills" | "targets" | "workspace";

interface PermissionCopy {
  group: PermissionGroup;
  label: string;
  description: string;
  /** Whether the permission only reads; offered by the picker's read-only shortcut. */
  readOnly: boolean;
}

/**
 * How the token permission picker describes each grantable permission. Keyed by every grantable
 * permission, so making a permission grantable does not compile until it has copy here.
 */
export const PERSONAL_ACCESS_TOKEN_PERMISSION_COPY = {
  "sessions.read": {
    group: "sessions",
    label: "Read sessions",
    description: "List sessions and read their events, messages, and changes",
    readOnly: true,
  },
  "sessions.create": {
    group: "sessions",
    label: "Create sessions",
    description: "Start new sessions",
    readOnly: false,
  },
  "sessions.collaborate": {
    group: "sessions",
    label: "Collaborate in sessions",
    description: "Send prompts to sessions you can collaborate in",
    readOnly: false,
  },
  "sessions.lifecycle": {
    group: "sessions",
    label: "Manage session lifecycle",
    description: "Stop, archive, rename, and restore sessions",
    readOnly: false,
  },
  "sessions.sandbox_access": {
    group: "sessions",
    label: "Access sandboxes",
    description: "Reach a session's sandbox tools and preview tunnels",
    readOnly: false,
  },
  "sessions.export": {
    group: "sessions",
    label: "Export sessions",
    description: "Export session transcripts",
    readOnly: true,
  },
  "sessions.delete": {
    group: "sessions",
    label: "Delete sessions",
    description: "Permanently delete sessions",
    readOnly: false,
  },
  "sessions.bulk_archive": {
    group: "sessions",
    label: "Archive sessions in bulk",
    description: "Archive many sessions in one request",
    readOnly: false,
  },
  "automations.read": {
    group: "automations",
    label: "Read automations",
    description: "List automations and their runs",
    readOnly: true,
  },
  "automations.create": {
    group: "automations",
    label: "Create automations",
    description: "Create automations that run as you",
    readOnly: false,
  },
  "automations.trigger.own": {
    group: "automations",
    label: "Run your automations",
    description: "Trigger automations you execute or lead",
    readOnly: false,
  },
  "automations.trigger.any": {
    group: "automations",
    label: "Run any automation",
    description: "Trigger any automation in the workspace",
    readOnly: false,
  },
  "automations.manage.own": {
    group: "automations",
    label: "Manage your automations",
    description: "Edit, pause, and delete automations you execute or lead",
    readOnly: false,
  },
  "automations.manage.any": {
    group: "automations",
    label: "Manage any automation",
    description: "Edit, pause, and delete any automation in the workspace",
    readOnly: false,
  },
  "skills.read": {
    group: "skills",
    label: "Read skills",
    description: "List managed skills and their content",
    readOnly: true,
  },
  "skills.manage": {
    group: "skills",
    label: "Manage skills",
    description: "Create, import, update, and delete managed skills",
    readOnly: false,
  },
  "skill_profiles.manage_own": {
    group: "skills",
    label: "Manage your skill profiles",
    description: "Create and edit your own skill profiles",
    readOnly: false,
  },
  "memories.manage_own": {
    group: "skills",
    label: "Manage your memories",
    description: "Create and edit your personal memories",
    readOnly: false,
  },
  "repositories.read": {
    group: "targets",
    label: "Read repositories",
    description: "List repositories, branches, and metadata",
    readOnly: true,
  },
  "repositories.use": {
    group: "targets",
    label: "Use repositories",
    description: "Target repositories with sessions and automations",
    readOnly: false,
  },
  "environments.read": {
    group: "targets",
    label: "Read environments",
    description: "List environments and their repositories",
    readOnly: true,
  },
  "environments.use": {
    group: "targets",
    label: "Use environments",
    description: "Target environments with sessions and automations",
    readOnly: false,
  },
  "image_builds.read": {
    group: "targets",
    label: "Read image builds",
    description: "See prebuilt image status",
    readOnly: true,
  },
  "analytics.read": {
    group: "workspace",
    label: "Read analytics",
    description: "Read usage and run analytics",
    readOnly: true,
  },
  "workspace.audit.read": {
    group: "workspace",
    label: "Read the audit log",
    description: "Read workspace audit events",
    readOnly: true,
  },
  "workspace.members.read": {
    group: "workspace",
    label: "Read members",
    description: "List workspace members and their roles",
    readOnly: true,
  },
  "workspace.roles.read": {
    group: "workspace",
    label: "Read roles",
    description: "List workspace roles and their permissions",
    readOnly: true,
  },
  "integrations.read": {
    group: "workspace",
    label: "Read integration settings",
    description: "Read Slack, GitHub, and Linear integration settings",
    readOnly: true,
  },
  "mcp_servers.read": {
    group: "workspace",
    label: "Read MCP servers",
    description: "List MCP servers configured for sessions",
    readOnly: true,
  },
  "provider_accounts.read": {
    group: "workspace",
    label: "Read provider accounts",
    description: "List connected model provider accounts",
    readOnly: true,
  },
} as const satisfies Record<PersonalAccessTokenGrantablePermission, PermissionCopy>;

/** Grantable permissions in display order: within each group, reads before writes. */
export const PERSONAL_ACCESS_TOKEN_PERMISSION_ORDER = Object.keys(
  PERSONAL_ACCESS_TOKEN_PERMISSION_COPY
) as PersonalAccessTokenGrantablePermission[];

/** Picker sections, in display order. */
export const PERSONAL_ACCESS_TOKEN_PERMISSION_GROUPS: readonly {
  id: PermissionGroup;
  label: string;
}[] = [
  { id: "sessions", label: "Sessions" },
  { id: "automations", label: "Automations" },
  { id: "skills", label: "Skills and memories" },
  { id: "targets", label: "Repositories and environments" },
  { id: "workspace", label: "Workspace" },
];

/** The label for a permission in a token's grant, falling back to its id for one no longer grantable. */
export function personalAccessTokenPermissionLabel(permission: string): string {
  return (
    (PERSONAL_ACCESS_TOKEN_PERMISSION_COPY as Record<string, PermissionCopy | undefined>)[
      permission
    ]?.label ?? permission
  );
}

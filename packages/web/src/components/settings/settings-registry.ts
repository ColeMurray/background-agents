import {
  AppearanceIcon,
  BoxIcon,
  ClockIcon,
  DataControlsIcon,
  FolderIcon,
  GitPrIcon,
  IntegrationsIcon,
  KeyboardIcon,
  KeyIcon,
  ModelIcon,
  SparkleIcon,
  TerminalIcon,
} from "@/components/ui/icons";
import { supportsRepoImages } from "@/lib/sandbox-provider";
import type { PermissionId } from "@open-inspect/shared/rbac";
import { matchesSearchTerms } from "@/lib/search";
import { lazy, type ComponentType, type LazyExoticComponent } from "react";

type SettingsPermissionPredicate = PermissionId | { allOf: readonly PermissionId[] };
type SettingsVisibility = { public: true } | { anyOf: readonly SettingsPermissionPredicate[] };
export type SettingsCapability = "unarchiveSessions";

interface SettingsItemDefinition {
  id: string;
  label: string;
  description: string;
  keywords: string;
  icon: ComponentType<{ className?: string }>;
  visibility: SettingsVisibility;
  panel: LazyExoticComponent<ComponentType>;
  capabilities?: Partial<Record<SettingsCapability, SettingsPermissionPredicate>>;
  requiresRepoImages?: boolean;
}

interface SettingsGroupDefinition {
  label: string;
  items: readonly SettingsItemDefinition[];
}

const publicSettings = { public: true } as const;

function allOf(...permissions: PermissionId[]): SettingsPermissionPredicate {
  return { allOf: permissions };
}

function anyOf(...predicates: SettingsPermissionPredicate[]): SettingsVisibility {
  return { anyOf: predicates };
}

function lazyPanel(load: () => Promise<ComponentType>): LazyExoticComponent<ComponentType> {
  return lazy(async () => ({ default: await load() }));
}

/** Settings categories and the permissions required for users to see them. */
export const SETTINGS_GROUPS = [
  {
    label: "Personal",
    items: [
      {
        id: "appearance",
        label: "Appearance",
        description: "Theme and code highlighting",
        keywords: "theme dark light syntax",
        icon: AppearanceIcon,
        visibility: publicSettings,
        panel: lazyPanel(() =>
          import("./appearance-settings").then(({ AppearanceSettings }) => AppearanceSettings)
        ),
      },
      {
        id: "keyboard-shortcuts",
        label: "Keyboard",
        description: "Customize keyboard shortcuts",
        keywords: "keys commands hotkeys",
        icon: KeyboardIcon,
        visibility: publicSettings,
        panel: lazyPanel(() =>
          import("./keyboard-shortcuts-settings").then(
            ({ KeyboardShortcutsSettings }) => KeyboardShortcutsSettings
          )
        ),
      },
    ],
  },
  {
    label: "Sessions",
    items: [
      {
        id: "models",
        label: "Models",
        description: "Choose models available to agents",
        keywords: "claude openai reasoning",
        icon: ModelIcon,
        visibility: anyOf("models.preferences.manage"),
        panel: lazyPanel(() =>
          import("./models-settings").then(({ ModelsSettings }) => ModelsSettings)
        ),
      },
      {
        id: "provider-accounts",
        label: "Accounts",
        description: "Connect model provider subscriptions",
        keywords: "provider authentication credentials",
        icon: KeyIcon,
        visibility: anyOf("provider_accounts.read"),
        panel: lazyPanel(() =>
          import("./provider-accounts-settings").then(
            ({ ProviderAccountsSettings }) => ProviderAccountsSettings
          )
        ),
      },
      {
        id: "skills",
        label: "Skills",
        description: "Manage shared skills and profiles",
        keywords: "agent instructions profiles",
        icon: SparkleIcon,
        visibility: anyOf("skills.read"),
        panel: lazyPanel(() =>
          import("./skills-settings").then(({ SkillsSettings }) => SkillsSettings)
        ),
      },
    ],
  },
  {
    label: "Workspace",
    items: [
      {
        id: "workspace",
        label: "Workspace access",
        description: "Manage members and roles",
        keywords: "rbac permissions users access",
        icon: DataControlsIcon,
        visibility: anyOf("workspace.members.read", "workspace.roles.read"),
        panel: lazyPanel(() =>
          import("./workspace-settings").then(({ WorkspaceSettings }) => WorkspaceSettings)
        ),
      },
      {
        id: "audit-log",
        label: "Audit log",
        description: "Review workspace activity and access decisions",
        keywords: "audit security history events authorization operations compliance",
        icon: ClockIcon,
        visibility: anyOf("workspace.audit.read"),
        panel: lazyPanel(() =>
          import("./audit-log-settings").then(({ AuditLogSettings }) => AuditLogSettings)
        ),
      },
      {
        id: "environments",
        label: "Environments",
        description: "Configure reusable repository setups",
        keywords: "repositories branches prebuild",
        icon: FolderIcon,
        visibility: anyOf("environments.read"),
        panel: lazyPanel(() =>
          import("./environments-settings").then(({ EnvironmentsSettings }) => EnvironmentsSettings)
        ),
      },
      {
        id: "secrets",
        label: "Secrets",
        description: "Manage global and repository secrets",
        keywords: "environment variables credentials",
        icon: KeyIcon,
        visibility: anyOf(
          "global_secrets.manage",
          allOf("repositories.secrets.manage", "repositories.read")
        ),
        panel: lazyPanel(() =>
          import("./secrets-settings").then(({ SecretsSettings }) => SecretsSettings)
        ),
      },
      {
        id: "scm",
        label: "Source control",
        description: "Configure pull request behavior",
        keywords: "scm git pull request merge draft",
        icon: GitPrIcon,
        visibility: anyOf("integrations.read"),
        panel: lazyPanel(() =>
          import("./scm-settings").then(({ ScmSettingsPage }) => ScmSettingsPage)
        ),
      },
    ],
  },
  {
    label: "System",
    items: [
      {
        id: "sandbox",
        label: "Sandbox",
        description: "Set runtime resources and access",
        keywords: "terminal ports cpu memory timeout",
        icon: TerminalIcon,
        visibility: anyOf("integrations.read"),
        panel: lazyPanel(() =>
          import("./sandbox-settings").then(({ SandboxSettingsPage }) => SandboxSettingsPage)
        ),
      },
      {
        id: "images",
        label: "Images",
        description: "Manage repository image builds",
        keywords: "prebuild containers",
        icon: BoxIcon,
        requiresRepoImages: true,
        visibility: anyOf(allOf("image_builds.read", "repositories.read")),
        panel: lazyPanel(() =>
          import("./images-settings").then(({ ImagesSettings }) => ImagesSettings)
        ),
      },
      {
        id: "integrations",
        label: "Integrations",
        description: "Connect external tools and services",
        keywords: "github slack linear vnc code server",
        icon: IntegrationsIcon,
        visibility: anyOf("integrations.read"),
        panel: lazyPanel(() =>
          import("./integrations-settings").then(({ IntegrationsSettings }) => IntegrationsSettings)
        ),
      },
      {
        id: "mcp-servers",
        label: "MCP Servers",
        description: "Configure local and remote MCP servers",
        keywords: "tools protocol command url",
        icon: TerminalIcon,
        visibility: anyOf("mcp_servers.read"),
        panel: lazyPanel(() =>
          import("./mcp-servers-settings").then(({ McpServersSettings }) => McpServersSettings)
        ),
      },
      {
        id: "data-controls",
        label: "Data Controls",
        description: "Review and restore archived sessions",
        keywords: "archive restore retention",
        icon: DataControlsIcon,
        visibility: anyOf("sessions.read"),
        capabilities: { unarchiveSessions: "sessions.lifecycle" },
        panel: lazyPanel(() =>
          import("./data-controls-settings").then(
            ({ DataControlsSettings }) => DataControlsSettings
          )
        ),
      },
    ],
  },
] as const satisfies readonly SettingsGroupDefinition[];

type SettingsItem = (typeof SETTINGS_GROUPS)[number]["items"][number];
/** Identifier for a registered settings category. */
export type SettingsCategory = SettingsItem["id"];
export const DEFAULT_SETTINGS_CATEGORY: SettingsCategory = "secrets";
const DEFAULT_SETTINGS_QUERY = "";

/** Returns whether the user's effective permissions make a settings category visible. */
export function canViewSettingsCategory(
  category: SettingsCategory,
  hasPermission: (permission: PermissionId) => boolean
): boolean {
  const visibility = getSettingsItem(category).visibility;
  return (
    "public" in visibility ||
    visibility.anyOf.some((predicate) =>
      typeof predicate === "string"
        ? hasPermission(predicate)
        : predicate.allOf.every(hasPermission)
    )
  );
}

/** Evaluates a named panel capability from the same descriptor used by settings navigation. */
export function canUseSettingsCapability(
  category: SettingsCategory,
  capability: SettingsCapability,
  hasPermission: (permission: PermissionId) => boolean
): boolean {
  const item: SettingsItemDefinition = getSettingsItem(category);
  if (!("capabilities" in item)) return false;
  const predicate = item.capabilities?.[capability];
  if (!predicate) return false;
  return typeof predicate === "string"
    ? hasPermission(predicate)
    : predicate.allOf.every(hasPermission);
}

/** Selects the requested visible category, or a category the user is allowed to view. */
export function resolveSettingsCategory(
  requested: string | null,
  repoImagesEnabled: boolean,
  hasPermission: (permission: PermissionId) => boolean
): SettingsCategory {
  if (
    isSettingsCategory(requested, repoImagesEnabled) &&
    canViewSettingsCategory(requested, hasPermission)
  ) {
    return requested;
  }
  if (canViewSettingsCategory(DEFAULT_SETTINGS_CATEGORY, hasPermission)) {
    return DEFAULT_SETTINGS_CATEGORY;
  }
  for (const group of SETTINGS_GROUPS) {
    for (const item of group.items) {
      if (
        isSettingsItemAvailable(item, repoImagesEnabled) &&
        canViewSettingsCategory(item.id, hasPermission)
      ) {
        return item.id;
      }
    }
  }
  return "appearance";
}

function isSettingsItemAvailable(item: SettingsItem, repoImagesEnabled: boolean): boolean {
  return !("requiresRepoImages" in item) || repoImagesEnabled;
}

/** Returns settings groups filtered to categories the user may view and the current search. */
export function getSettingsGroups({
  query = DEFAULT_SETTINGS_QUERY,
  repoImagesEnabled = supportsRepoImages(),
  hasPermission,
}: {
  query?: string;
  repoImagesEnabled?: boolean;
  hasPermission: (permission: PermissionId) => boolean;
}) {
  return SETTINGS_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => {
      if (!isSettingsItemAvailable(item, repoImagesEnabled)) return false;
      if (!canViewSettingsCategory(item.id, hasPermission)) return false;
      return matchesSearchTerms(`${item.label} ${item.description} ${item.keywords}`, query);
    }),
  })).filter((group) => group.items.length > 0);
}

/** Returns the user-facing label for a settings category. */
export function getSettingsCategoryLabel(category: SettingsCategory): string {
  return getSettingsItem(category).label;
}

/** Returns the panel shown for an authorized settings category. */
export function getSettingsPanel(category: SettingsCategory): LazyExoticComponent<ComponentType> {
  return getSettingsItem(category).panel;
}

export function isSettingsCategory(
  value: string | null,
  repoImagesEnabled = supportsRepoImages()
): value is SettingsCategory {
  if (!value) return false;
  return SETTINGS_GROUPS.some((group) =>
    group.items.some(
      (item) => item.id === value && isSettingsItemAvailable(item, repoImagesEnabled)
    )
  );
}

function getSettingsItem(category: SettingsCategory): SettingsItem {
  for (const group of SETTINGS_GROUPS) {
    for (const item of group.items) {
      if (item.id === category) return item;
    }
  }
  throw new Error(`Unknown settings category: ${category}`);
}

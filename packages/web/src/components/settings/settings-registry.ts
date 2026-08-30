import {
  AppearanceIcon,
  BoxIcon,
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
      },
      {
        id: "keyboard-shortcuts",
        label: "Keyboard",
        description: "Customize keyboard shortcuts",
        keywords: "keys commands hotkeys",
        icon: KeyboardIcon,
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
      },
      {
        id: "provider-accounts",
        label: "Accounts",
        description: "Connect model provider subscriptions",
        keywords: "provider authentication credentials",
        icon: KeyIcon,
      },
      {
        id: "skills",
        label: "Skills",
        description: "Manage shared skills and profiles",
        keywords: "agent instructions profiles",
        icon: SparkleIcon,
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
      },
      {
        id: "environments",
        label: "Environments",
        description: "Configure reusable repository setups",
        keywords: "repositories branches prebuild",
        icon: FolderIcon,
      },
      {
        id: "secrets",
        label: "Secrets",
        description: "Manage global and repository secrets",
        keywords: "environment variables credentials",
        icon: KeyIcon,
      },
      {
        id: "scm",
        label: "Source control",
        description: "Configure pull request behavior",
        keywords: "scm git pull request merge draft",
        icon: GitPrIcon,
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
      },
      {
        id: "images",
        label: "Images",
        description: "Manage repository image builds",
        keywords: "prebuild containers",
        icon: BoxIcon,
        requiresRepoImages: true,
      },
      {
        id: "integrations",
        label: "Integrations",
        description: "Connect external tools and services",
        keywords: "github slack linear vnc code server",
        icon: IntegrationsIcon,
      },
      {
        id: "mcp-servers",
        label: "MCP Servers",
        description: "Configure local and remote MCP servers",
        keywords: "tools protocol command url",
        icon: TerminalIcon,
      },
      {
        id: "data-controls",
        label: "Data Controls",
        description: "Review and restore archived sessions",
        keywords: "archive restore retention",
        icon: DataControlsIcon,
      },
    ],
  },
] as const;

type SettingsItem = (typeof SETTINGS_GROUPS)[number]["items"][number];
export type SettingsCategory = SettingsItem["id"];
export const DEFAULT_SETTINGS_CATEGORY: SettingsCategory = "secrets";
export const DEFAULT_SETTINGS_QUERY = "";

export function canViewSettingsCategory(
  category: SettingsCategory,
  hasPermission: (permission: PermissionId) => boolean
): boolean {
  switch (category) {
    case "workspace":
      return hasPermission("workspace.members.read") || hasPermission("workspace.roles.read");
    case "secrets":
      return hasPermission("global_secrets.manage");
    case "environments":
      return hasPermission("environments.read");
    case "models":
      return hasPermission("models.preferences.manage");
    case "provider-accounts":
      return hasPermission("provider_accounts.read");
    case "images":
      return hasPermission("image_builds.read");
    case "sandbox":
      return hasPermission("integrations.read");
    case "scm":
    case "integrations":
      return hasPermission("integrations.read");
    case "skills":
      return hasPermission("skills.read");
    case "mcp-servers":
      return hasPermission("mcp_servers.read");
    case "data-controls":
      return hasPermission("sessions.read.any") || hasPermission("sessions.read.own");
    default:
      return true;
  }
}

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

export function getSettingsGroups({
  query = DEFAULT_SETTINGS_QUERY,
  repoImagesEnabled = supportsRepoImages(),
}: {
  query?: string;
  repoImagesEnabled?: boolean;
} = {}) {
  return SETTINGS_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => {
      if (!isSettingsItemAvailable(item, repoImagesEnabled)) return false;
      return matchesSearchTerms(`${item.label} ${item.description} ${item.keywords}`, query);
    }),
  })).filter((group) => group.items.length > 0);
}

export function getSettingsCategoryLabel(category: SettingsCategory): string {
  for (const group of SETTINGS_GROUPS) {
    for (const item of group.items) {
      if (item.id === category) return item.label;
    }
  }
  return category;
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

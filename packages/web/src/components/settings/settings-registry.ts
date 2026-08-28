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
export const DEFAULT_INCLUDE_GLOBAL_SETTINGS_ALIASES = false;

function isSettingsItemAvailable(item: SettingsItem, repoImagesEnabled: boolean): boolean {
  return !("requiresRepoImages" in item) || repoImagesEnabled;
}

export function getSettingsGroups({
  query = DEFAULT_SETTINGS_QUERY,
  repoImagesEnabled = supportsRepoImages(),
  includeGlobalAliases = DEFAULT_INCLUDE_GLOBAL_SETTINGS_ALIASES,
}: {
  query?: string;
  repoImagesEnabled?: boolean;
  includeGlobalAliases?: boolean;
} = {}) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return SETTINGS_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => {
      if (!isSettingsItemAvailable(item, repoImagesEnabled)) return false;
      const aliases = includeGlobalAliases ? `settings ${group.label}` : "";
      const searchText =
        `${aliases} ${item.label} ${item.description} ${item.keywords}`.toLowerCase();
      return terms.every((term) => searchText.includes(term));
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

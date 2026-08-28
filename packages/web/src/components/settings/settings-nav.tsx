"use client";

import Link from "next/link";
import { useState } from "react";
import { useIsMobile } from "@/hooks/use-media-query";
import {
  AppearanceIcon,
  BackIcon,
  BoxIcon,
  ChevronRightIcon,
  DataControlsIcon,
  FolderIcon,
  GitPrIcon,
  IntegrationsIcon,
  KeyboardIcon,
  KeyIcon,
  ModelIcon,
  SearchIcon,
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

function isSettingsItemAvailable(item: SettingsItem, repoImagesEnabled: boolean): boolean {
  return !("requiresRepoImages" in item) || repoImagesEnabled;
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

interface SettingsNavProps {
  activeCategory: SettingsCategory;
  onSelect: (category: SettingsCategory) => void;
  onNavigate?: () => void;
}

function SettingsSearch({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <label className="relative block">
      <span className="sr-only">Search settings</span>
      <SearchIcon
        aria-hidden="true"
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
      />
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Search settings"
        className="h-9 w-full rounded-md border border-border bg-input pl-9 pr-3 text-sm text-foreground shadow-sm outline-none transition placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/30"
      />
    </label>
  );
}

export function SettingsNav({ activeCategory, onSelect, onNavigate }: SettingsNavProps) {
  const isMobile = useIsMobile();
  const repoImagesEnabled = supportsRepoImages();
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const groups = SETTINGS_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => {
      if (!isSettingsItemAvailable(item, repoImagesEnabled)) return false;
      if (!normalizedQuery) return true;
      const searchText = `${item.label} ${item.description} ${item.keywords}`.toLowerCase();
      return normalizedQuery.split(/\s+/).every((term) => searchText.includes(term));
    }),
  })).filter((group) => group.items.length > 0);

  const navigation = (
    <div className="space-y-6">
      {groups.map((group) => (
        <section key={group.label} aria-labelledby={`settings-${group.label.toLowerCase()}`}>
          <h2
            id={`settings-${group.label.toLowerCase()}`}
            className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"
          >
            {group.label}
          </h2>
          <ul
            className={
              isMobile
                ? "divide-y divide-border-muted overflow-hidden rounded-xl border border-border-muted bg-card"
                : "space-y-1"
            }
          >
            {group.items.map((item) => {
              const isActive = activeCategory === item.id;
              const Icon = item.icon;
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(item.id);
                      onNavigate?.();
                    }}
                    aria-current={!isMobile && isActive ? "page" : undefined}
                    className={`flex w-full items-center gap-3 text-left transition ${
                      isMobile
                        ? "px-4 py-3.5 text-foreground hover:bg-muted/60"
                        : `rounded-md px-3 py-2 ${
                            isActive
                              ? "bg-muted font-medium text-foreground"
                              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                          }`
                    }`}
                  >
                    <Icon
                      aria-hidden="true"
                      className={`h-4 w-4 shrink-0 ${isActive ? "text-foreground" : "text-muted-foreground"}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">{item.label}</span>
                      {isMobile && (
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          {item.description}
                        </span>
                      )}
                    </span>
                    {isMobile && (
                      <ChevronRightIcon
                        aria-hidden="true"
                        className="h-4 w-4 shrink-0 text-muted-foreground"
                      />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {groups.length === 0 && (
        <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
          No settings match “{query}”.
        </p>
      )}
    </div>
  );

  if (isMobile) {
    return (
      <nav aria-label="Settings" className="mx-auto w-full max-w-xl px-4 py-6">
        <p className="mb-5 text-sm text-muted-foreground">
          Manage your preferences, workspace, and connected services.
        </p>
        <div className="mb-6">
          <SettingsSearch value={query} onChange={setQuery} />
        </div>
        {navigation}
      </nav>
    );
  }

  return (
    <nav
      aria-label="Settings"
      className="flex w-60 shrink-0 flex-col border-r border-border-muted bg-muted/15"
    >
      <div className="border-b border-border-muted px-4 py-4">
        <Link
          href="/"
          className="mb-5 flex items-center gap-2 text-sm text-muted-foreground transition hover:text-foreground"
        >
          <BackIcon aria-hidden="true" className="h-4 w-4" />
          Back to app
        </Link>
        <h1 className="mb-3 text-lg font-semibold text-foreground">Settings</h1>
        <SettingsSearch value={query} onChange={setQuery} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-5">{navigation}</div>
    </nav>
  );
}

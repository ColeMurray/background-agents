"use client";

import Link from "next/link";
import { useState } from "react";
import { BackIcon, ChevronRightIcon, SearchIcon } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSettingsIsMobile } from "./settings-viewport-context";
import { getSettingsGroups, type SettingsCategory } from "./settings-registry";

export {
  DEFAULT_SETTINGS_CATEGORY,
  getSettingsCategoryLabel,
  isSettingsCategory,
  type SettingsCategory,
} from "./settings-registry";

interface SettingsNavProps {
  activeCategory: SettingsCategory;
  onSelect: (category: SettingsCategory, trigger: HTMLButtonElement) => void;
}

function SettingsSearch({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <label className="relative block">
      <span className="sr-only">Search settings</span>
      <span aria-hidden="true">
        <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      </span>
      <Input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Search settings"
        className="pl-9"
      />
    </label>
  );
}

export function SettingsNav({ activeCategory, onSelect }: SettingsNavProps) {
  const isMobile = useSettingsIsMobile();
  const [query, setQuery] = useState("");
  const groups = getSettingsGroups({ query });

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
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={(event) => {
                      onSelect(item.id, event.currentTarget);
                    }}
                    aria-current={isActive ? "page" : undefined}
                    className={`h-auto w-full justify-start gap-3 whitespace-normal rounded-md text-left ${
                      isMobile
                        ? "px-4 py-3.5 text-foreground hover:bg-muted/60"
                        : `px-3 py-2 ${
                            isActive
                              ? "bg-muted font-medium text-foreground"
                              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                          }`
                    }`}
                  >
                    <span aria-hidden="true">
                      <Icon
                        className={`h-4 w-4 shrink-0 ${isActive ? "text-foreground" : "text-muted-foreground"}`}
                      />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">{item.label}</span>
                      {isMobile && (
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          {item.description}
                        </span>
                      )}
                    </span>
                    {isMobile && (
                      <span aria-hidden="true">
                        <ChevronRightIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                      </span>
                    )}
                  </Button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {groups.length === 0 && (
        <p
          aria-live="polite"
          className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground"
        >
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
        <Button asChild variant="ghost" size="sm" className="mb-5 -ml-3 gap-2">
          <Link href="/">
            <span aria-hidden="true">
              <BackIcon className="h-4 w-4" />
            </span>
            Back to app
          </Link>
        </Button>
        <h1 className="mb-3 text-lg font-semibold text-foreground">Settings</h1>
        <SettingsSearch value={query} onChange={setQuery} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-5">{navigation}</div>
    </nav>
  );
}

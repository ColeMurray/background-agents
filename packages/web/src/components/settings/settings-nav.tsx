"use client";

import { useIsMobile } from "@/hooks/use-media-query";
import {
  KeyIcon,
  ModelIcon,
  KeyboardIcon,
  DataControlsIcon,
  ChevronRightIcon,
} from "@/components/ui/icons";

const NAV_ITEMS = [
  {
    id: "secrets",
    label: "Secrets",
    icon: KeyIcon,
  },
  {
    id: "models",
    label: "Models",
    icon: ModelIcon,
  },
  {
    id: "keyboard-shortcuts",
    label: "Keyboard",
    icon: KeyboardIcon,
  },
  {
    id: "data-controls",
    label: "Data Controls",
    icon: DataControlsIcon,
  },
] as const;

export type SettingsCategory = (typeof NAV_ITEMS)[number]["id"];

interface SettingsNavProps {
  activeCategory: SettingsCategory;
  onSelect: (category: SettingsCategory) => void;
  onNavigate?: () => void;
}

export function SettingsNav({ activeCategory, onSelect, onNavigate }: SettingsNavProps) {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <nav className="p-4">
        <h2 className="text-lg font-semibold text-foreground mb-4">Settings</h2>
        <ul className="space-y-1">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <li key={item.id}>
                <button
                  onClick={() => {
                    onSelect(item.id);
                    onNavigate?.();
                  }}
                  className="w-full flex items-center gap-2 px-3 py-3 text-sm rounded transition text-foreground hover:bg-muted"
                >
                  <Icon className="w-4 h-4" />
                  <span className="flex-1 text-left">{item.label}</span>
                  <ChevronRightIcon className="w-4 h-4 text-muted-foreground" />
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
    );
  }

  return (
    <nav className="w-48 flex-shrink-0 border-r border-border-muted p-4">
      <h2 className="text-lg font-semibold text-foreground mb-4">Settings</h2>
      <ul className="space-y-1">
        {NAV_ITEMS.map((item) => {
          const isActive = activeCategory === item.id;
          const Icon = item.icon;
          return (
            <li key={item.id}>
              <button
                onClick={() => onSelect(item.id)}
                className={`w-full flex items-center gap-2 px-3 py-2 text-sm rounded transition ${
                  isActive
                    ? "text-foreground bg-muted font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                }`}
              >
                <Icon className="w-4 h-4" />
                {item.label}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

"use client";

import { useTheme } from "next-themes";
import {
  useSyntaxHighlightPreferences,
  LIGHT_THEMES,
  DARK_THEMES,
  type ColorSchemeMode,
  type SyntaxHighlightThemeDefinition,
} from "@/hooks/use-syntax-highlight-preferences";
import { APP_THEMES, DEFAULT_APP_THEME } from "@/lib/app-themes";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { SunIcon, MoonIcon, MonitorIcon } from "@/components/ui/icons";

const COLOR_SCHEME_OPTIONS: { value: ColorSchemeMode; label: string; icon: typeof SunIcon }[] = [
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
  { value: "system", label: "System", icon: MonitorIcon },
];

function ThemeRow({
  label,
  description,
  value,
  themes,
  onChange,
}: {
  label: string;
  description: string;
  value: string;
  themes: SyntaxHighlightThemeDefinition[];
  onChange: (id: string) => void;
}) {
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <div>
        <span className="text-sm text-foreground">{label}</span>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="text-sm bg-background border border-border rounded px-2 py-1.5 text-foreground"
      >
        {themes.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function AppearanceSettings() {
  const { colorSchemeMode, preferredLightTheme, preferredDarkTheme, update } =
    useSyntaxHighlightPreferences();
  const { theme, setTheme } = useTheme();

  return (
    <div>
      <h2 className="text-xl font-semibold text-foreground mb-1">Appearance</h2>
      <p className="text-sm text-muted-foreground mb-6">
        Customize the appearance of the application.
      </p>

      {/* App theme section */}
      <div className="mb-8">
        <h3 className="text-base font-medium text-foreground mb-1">App theme</h3>
        <p className="text-sm text-muted-foreground mb-4">
          Pick the look of the entire app. Default uses the built-in colors; System matches your OS
          preference; additional palettes can be registered in code and selected here.
        </p>

        <div className="border border-border rounded-md">
          <div className="flex items-center justify-between px-4 py-3">
            <div>
              <span className="text-sm text-foreground">Theme</span>
              <p className="text-xs text-muted-foreground mt-0.5">
                Your choice persists across sessions and overrides the deploy-time default.
              </p>
            </div>
            <select
              value={theme ?? DEFAULT_APP_THEME}
              onChange={(e) => setTheme(e.target.value)}
              className="text-sm bg-background border border-border rounded px-2 py-1.5 text-foreground"
            >
              {APP_THEMES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Code Highlighting section */}
      <div>
        <h3 className="text-base font-medium text-foreground mb-1">Code highlighting</h3>
        <p className="text-sm text-muted-foreground mb-4">
          Customize how code is displayed in sessions.
        </p>

        <div className="border border-border rounded-md divide-y divide-border-muted">
          {/* Color scheme mode toggle */}
          <div className="flex items-center justify-between px-4 py-3">
            <div>
              <span className="text-sm text-foreground">Color scheme</span>
              <p className="text-xs text-muted-foreground mt-0.5">
                Choose light, dark, or match your system theme
              </p>
            </div>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={colorSchemeMode}
              onValueChange={(value) => {
                if (value) update({ colorSchemeMode: value as ColorSchemeMode });
              }}
            >
              {COLOR_SCHEME_OPTIONS.map((opt) => {
                const Icon = opt.icon;
                return (
                  <ToggleGroupItem key={opt.value} value={opt.value}>
                    <Icon className="w-3.5 h-3.5" />
                    {opt.label}
                  </ToggleGroupItem>
                );
              })}
            </ToggleGroup>
          </div>

          <ThemeRow
            label="Light theme"
            description="Used when color scheme is light"
            value={preferredLightTheme}
            themes={LIGHT_THEMES}
            onChange={(v) => update({ preferredLightTheme: v })}
          />
          <ThemeRow
            label="Dark theme"
            description="Used when color scheme is dark"
            value={preferredDarkTheme}
            themes={DARK_THEMES}
            onChange={(v) => update({ preferredDarkTheme: v })}
          />
        </div>
      </div>
    </div>
  );
}

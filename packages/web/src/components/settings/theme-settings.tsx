"use client";

import { useState } from "react";
import { useTheme } from "@/components/theme-provider";
import { THEME_IDS, type ThemeId } from "@/lib/theme";

const THEME_LABELS: Record<ThemeId, string> = {
  tokyonight: "Tokyo Night",
  catppuccin: "Catppuccin",
  gruvbox: "Gruvbox",
  kanagawa: "Kanagawa",
  onedark: "One Dark",
};

const THEME_DESCRIPTIONS: Record<ThemeId, string> = {
  tokyonight: "Cool neon editor palette with blue accents.",
  catppuccin: "Soft pastel contrast with a calm terminal feel.",
  gruvbox: "Warm retro terminal tones and earthy contrast.",
  kanagawa: "Muted ink palette inspired by Japanese prints.",
  onedark: "Balanced IDE classic with subtle contrast.",
};

export function ThemeSettings() {
  const { theme, setTheme } = useTheme();
  const [savingTheme, setSavingTheme] = useState<ThemeId | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const onSelectTheme = async (nextTheme: ThemeId) => {
    if (nextTheme === theme || savingTheme) return;
    setSavingTheme(nextTheme);
    setError("");
    setSuccess("");

    try {
      await setTheme(nextTheme);
      setSuccess(`Theme changed to ${THEME_LABELS[nextTheme]}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to change theme.");
    } finally {
      setSavingTheme(null);
    }
  };

  return (
    <div>
      <h2 className="text-xl font-semibold text-foreground mb-1">Appearance</h2>
      <p className="text-sm text-muted-foreground mb-6">
        Pick your editor-inspired theme. Changes apply immediately and sync to your account.
      </p>

      {error && (
        <div className="mb-4 bg-destructive-muted text-destructive border border-destructive/40 px-4 py-3 text-sm">
          {error}
        </div>
      )}

      {success && (
        <div className="mb-4 bg-success-muted text-success border border-success/40 px-4 py-3 text-sm">
          {success}
        </div>
      )}

      <div className="grid gap-3">
        {THEME_IDS.map((themeId) => {
          const isActive = themeId === theme;
          const isSaving = savingTheme === themeId;
          return (
            <button
              key={themeId}
              type="button"
              onClick={() => onSelectTheme(themeId)}
              disabled={Boolean(savingTheme)}
              className={`text-left px-4 py-3 border transition ${
                isActive
                  ? "border-accent bg-accent-muted/60"
                  : "border-border hover:border-accent/50 hover:bg-muted"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-foreground">{THEME_LABELS[themeId]}</span>
                <span className="text-xs text-muted-foreground">
                  {isSaving ? "Saving..." : isActive ? "Active" : "Select"}
                </span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">{THEME_DESCRIPTIONS[themeId]}</p>
            </button>
          );
        })}
      </div>
    </div>
  );
}

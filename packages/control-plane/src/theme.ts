export const THEME_IDS = ["tokyonight", "catppuccin", "gruvbox", "kanagawa", "onedark"] as const;

export type ThemeId = (typeof THEME_IDS)[number];

export const DEFAULT_THEME_ID: ThemeId = "tokyonight";

export function isThemeId(value: string): value is ThemeId {
  return THEME_IDS.includes(value as ThemeId);
}

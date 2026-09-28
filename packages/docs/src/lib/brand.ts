/**
 * The site palette as JavaScript values, for the renderers that cannot read the
 * CSS custom properties in `src/app/globals.css`: `next/og` rasterizes the
 * favicon and social cards outside the page, and Mermaid takes its theme as an
 * object. `brand.test.ts` holds every token here equal to its `--color-fd-*`
 * counterpart, which stays the source of record for the rendered site.
 */
type BrandScheme = {
  background: string;
  foreground: string;
  muted: string;
  mutedForeground: string;
  card: string;
  secondary: string;
  accentForeground: string;
  ring: string;
};

export const brand: { light: BrandScheme; dark: BrandScheme } = {
  light: {
    background: "#f8f8f6",
    foreground: "#1a1a1a",
    muted: "#f0efeb",
    mutedForeground: "#666666",
    card: "#f2f1ed",
    secondary: "#eceae4",
    accentForeground: "#6f5a41",
    ring: "#8b7355",
  },
  dark: {
    background: "#171715",
    foreground: "#f8f8f6",
    muted: "#22221f",
    mutedForeground: "#aaa79f",
    card: "#20201d",
    secondary: "#252521",
    accentForeground: "#d7c2a8",
    ring: "#b89b78",
  },
};

/**
 * A `#rrggbb` token as an `rgba()` string. `globals.css` derives its borders
 * from the foreground the same way (`--color-fd-border: rgb(26 26 26 / 12%)`),
 * so the alpha stays the only number that differs.
 */
export function withAlpha(color: string, alpha: number): string {
  const channels = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!channels) throw new Error(`expected a #rrggbb color, received ${color}`);
  const [red, green, blue] = channels.slice(1).map((channel) => parseInt(channel, 16));
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

/** Opacity of a border drawn over the background, matching `--color-fd-border`. */
export const borderAlpha = 0.12;

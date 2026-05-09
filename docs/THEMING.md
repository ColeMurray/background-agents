# Theming Guide

The Open-Inspect web app uses a token-based theming system. Every color comes from a CSS custom
property defined in [`packages/web/src/app/globals.css`](../packages/web/src/app/globals.css), and
components reference those tokens through Tailwind semantic classes (`bg-background`,
`text-foreground`, `border-border`, …) — never raw hex values. That indirection is what lets the
"App theme" picker in **Settings → Appearance** swap the entire UI between light and dark instantly,
and what makes adding a new themed palette later a contained change.

## Architecture

Three layers cooperate:

1. **CSS custom properties in `globals.css`.** Each visual concept (background, foreground, accent,
   border, etc.) is a `--token`. Light values live in `:root`, dark values live in `.dark`, and a
   `@media (prefers-color-scheme: dark)` block exists as a no-JS fallback so the page doesn't flash
   white before hydration on dark systems.
2. **Tailwind semantic utilities** (`bg-background`, `text-muted-foreground`, …). They are wired to
   the CSS tokens in the Tailwind config, so writing `className="bg-card text-foreground"` follows
   the active theme automatically.
3. **`next-themes`** in
   [`packages/web/src/app/providers.tsx`](../packages/web/src/app/providers.tsx). It manages the
   `dark` class on `<html>`, persists the user's choice to localStorage, hydrates on mount without a
   flash, and syncs across tabs. The Appearance picker is a thin UI on top of `useTheme()`.

## Token catalog

The current tokens (all defined in `globals.css`):

| Token                                                                                      | Purpose                                   |
| ------------------------------------------------------------------------------------------ | ----------------------------------------- |
| `--background`, `--foreground`                                                             | Page background and primary text          |
| `--card`, `--card-foreground`                                                              | Card / panel surface and its text         |
| `--popover`, `--popover-foreground`                                                        | Dropdown / popover surface and its text   |
| `--primary`, `--primary-foreground`                                                        | Primary button (inverted)                 |
| `--secondary`, `--secondary-foreground`                                                    | Secondary surface and de-emphasized text  |
| `--accent`, `--accent-foreground`, `--accent-muted`                                        | Brand accent + foreground + tinted bg     |
| `--muted`, `--muted-foreground`                                                            | Subtle background tint and secondary text |
| `--destructive`, `--destructive-foreground`, `--destructive-muted`, `--destructive-border` | Error / destructive states                |
| `--success`, `--success-muted`                                                             | Success states                            |
| `--warning`, `--warning-foreground`, `--warning-muted`                                     | Warning states                            |
| `--info`, `--info-foreground`, `--info-muted`                                              | Info states                               |
| `--border`, `--border-muted`                                                               | Borders and dividers                      |
| `--input`                                                                                  | Form field background                     |
| `--ring`                                                                                   | Focus outline                             |
| `--overlay`                                                                                | Modal / drawer scrim                      |
| `--radius`                                                                                 | Default border radius                     |

If a new visual concept doesn't fit an existing token, **add a token** (with light + dark values)
before introducing a hard-coded color. Tokens are cheap; hard-coded colors leak.

## Switching themes at runtime

The Appearance picker calls `setTheme(<id>)` from `next-themes`. That:

- Sets the active theme's `id` as a class on `<html>` (so `.blue { ... }` rules win when the user
  picks "Blue", `.dark` for "Dark", and so on).
- Persists the choice to `localStorage` (`theme` key).
- Survives reloads and syncs across browser tabs.

Components that need to react to the active theme can read it from `useTheme()` —
[`syntax-highlight-theme.tsx`](../packages/web/src/components/syntax-highlight-theme.tsx) reads both
`theme` and `resolvedTheme` to pick the right hljs stylesheet, and
[`ui/sonner.tsx`](../packages/web/src/components/ui/sonner.tsx) reads the active theme so toasts
match.

## The theme registry

All available themes live in
[`packages/web/src/lib/app-themes.ts`](../packages/web/src/lib/app-themes.ts):

```ts
export const APP_THEMES: AppTheme[] = [
  { id: "light", label: "Default", colorScheme: "light" },
  { id: "dark", label: "Dark", colorScheme: "dark" },
  { id: "system", label: "System", colorScheme: "system" },
  { id: "blue", label: "Blue", colorScheme: "light" },
];
```

`id` is what gets put on `<html>` and what users persist; `label` shows in the picker; `colorScheme`
tells the rest of the app whether to treat this theme as light, dark, or auto-following the OS —
primarily so syntax highlighting picks the right hljs stylesheet for a custom palette.

## Setting a default theme on deploy

Useful when you want a company-branded theme to be the first thing every new visitor sees, without
forcing it on them — users can still switch in Settings → Appearance and their choice persists.

Set the `app_default_theme` tfvar in
[`terraform/environments/production/terraform.tfvars`](../terraform/environments/production/terraform.tfvars.example):

```hcl
app_default_theme = "blue"
```

The variable is validated against the known theme ids in `variables.tf` (and again at runtime — an
unknown id silently falls back to `"system"` so a typo never ships a broken UI). The value becomes
`NEXT_PUBLIC_APP_DEFAULT_THEME` at build time, which `site-config.ts` reads and feeds to
next-themes' `defaultTheme` prop. Because `NEXT_PUBLIC_*` vars are inlined into the client bundle,
**you must redeploy the web app for a change to take effect** (rebuild + push for Cloudflare, new
Vercel deployment for Vercel).

Default is `"system"` — the historical behavior.

## Adding a new branded theme

To ship your own brand (e.g., "Acme Purple"):

1. **Add a CSS rule in [`globals.css`](../packages/web/src/app/globals.css).** Use a class selector
   that matches the theme id you'll register:

   ```css
   .acme-purple {
     --accent: #7b3ff2;
     --ring: #7b3ff2;
     --background: #1a0d2e;
     --foreground: #f4f0ff;
     /* leave the rest inheriting from :root */
   }
   ```

   You only need to override the tokens that change; everything else inherits from `:root`.
   Each named palette is light-only or dark-only — `next-themes` is configured with
   `attribute="class"`, which puts a single theme class on `<html>` at a time, so
   selectors like `.acme-purple.dark` never match. If you want both a light and dark
   variant of a brand, register them as two separate themes (e.g., `acme-purple` and
   `acme-purple-dark`).

2. **Register it in [`app-themes.ts`](../packages/web/src/lib/app-themes.ts).** Add an entry to
   `APP_THEMES`:

   ```ts
   { id: "acme-purple", label: "Acme Purple", colorScheme: "dark" },
   ```

   Pick `colorScheme: "light"` if your palette has light backgrounds, `"dark"` for dark — this is
   what syntax highlighting reads when deciding whether to pair the palette with a light or dark
   hljs stylesheet.

3. **Allow it in [`variables.tf`](../terraform/environments/production/variables.tf).** Add the id
   to the `app_default_theme` validation `contains(...)` list, otherwise `terraform plan` will
   reject it when a deployer sets it as the default:

   ```hcl
   condition = contains(["light", "dark", "system", "blue", "acme-purple"], var.app_default_theme)
   ```

4. **(Optional) Set it as your deploy-time default.** In `terraform.tfvars`:

   ```hcl
   app_default_theme = "acme-purple"
   ```

The shipped "Blue" theme exists as a worked example of all of the above — feel free to delete it
once you have your own brand wired up.

## Rules for component authors

- **Reach for a semantic token first.** If you're typing `bg-white`, `text-gray-700`, or
  `border-zinc-200`, stop and find the matching token. Almost always there is one (`bg-background`,
  `text-muted-foreground`, `border-border`).
- **Pair every raw color with a `dark:` variant if you must use one.** `text-gray-900` alone breaks
  on dark; `text-gray-900 dark:text-gray-50` works but is still worse than `text-foreground`. Save
  the dual-class form for the rare case where the design genuinely diverges from the tokens.
- **Add tokens when needed.** Brand colors (chart series, status pills, custom accents) belong in
  the variable layer too — `--chart-1`, `--status-success-strong`, etc. — with a dark counterpart.
  This keeps the dark theme honest.
- **Trust portals.** Radix Dialog / Popover / DropdownMenu portals render outside the React tree but
  inherit `<html class="dark">`, so theme tokens work without extra wiring.

## Auditing for regressions

Before merging UI changes, grep for hard-coded colors that aren't paired with `dark:`:

```bash
rg -n '\b(bg|text|border)-(white|black|gray-|zinc-|slate-|neutral-|stone-)' packages/web/src \
  --glob '!*.test.*' | rg -v 'dark:'
```

Each hit is either a missing token replacement or a missing `dark:` pair. Fix both kinds.

## Related

- [globals.css](../packages/web/src/app/globals.css) — the source of truth for tokens.
- [providers.tsx](../packages/web/src/app/providers.tsx) — `next-themes` wiring.
- [appearance-settings.tsx](../packages/web/src/components/settings/appearance-settings.tsx) — the
  user-facing picker.

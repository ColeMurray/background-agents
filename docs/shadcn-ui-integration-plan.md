# shadcn/ui Integration Plan

## Motivation

The web package (`packages/web`) currently has a small set of hand-rolled primitives (`Button`,
`Badge`, `Combobox`, `Select`, `RadioCard`) but lacks accessible, composable components for common
UI patterns: dialogs, dropdown menus, tooltips, tabs, inputs, toasts, and more. As the UI grows,
building each from scratch is slow and error-prone — especially around accessibility (focus
trapping, keyboard navigation, screen reader announcements).

**shadcn/ui** provides copy-paste Radix-based components with:

- Built-in accessibility (WAI-ARIA patterns, keyboard navigation, focus management)
- Tailwind + CSS variable styling (matches our existing token system)
- Source ownership — components live in our codebase, no external dependency lock-in
- Incremental adoption — add components one at a time

## Current State

### Design tokens

All semantic colors are defined as CSS custom properties in `globals.css` with light/dark variants.
Tailwind maps them in `tailwind.config.ts` via `theme.extend.colors`.

**Existing tokens:**

| Token                    | Light                  | Dark                     | shadcn equivalent      |
| ------------------------ | ---------------------- | ------------------------ | ---------------------- |
| `--background`           | `#f8f8f6`              | `#1a1a1a`                | `--background`         |
| `--foreground`           | `#1a1a1a`              | `#f8f8f6`                | `--foreground`         |
| `--card`                 | `#f8f8f6`              | `rgba(255,255,255,0.05)` | `--card`               |
| `--card-foreground`      | `#1a1a1a`              | `#f8f8f6`                | `--card-foreground`    |
| `--primary`              | `#1a1a1a`              | `#f8f8f6`                | `--primary`            |
| `--primary-foreground`   | `#ffffff`              | `#1a1a1a`                | `--primary-foreground` |
| `--accent`               | `#8b7355`              | `#a68b6a`                | `--accent`             |
| `--accent-foreground`    | `#ffffff`              | `#ffffff`                | `--accent-foreground`  |
| `--accent-muted`         | `rgba(139,115,85,0.1)` | `rgba(139,115,85,0.2)`   | _(custom, keep)_       |
| `--muted`                | `rgba(0,0,0,0.05)`     | `rgba(255,255,255,0.05)` | `--muted`              |
| `--muted-foreground`     | `#666666`              | `#999999`                | `--muted-foreground`   |
| `--secondary-foreground` | `#999999`              | `#666666`                | _(custom, keep)_       |
| `--border`               | `rgba(0,0,0,0.1)`      | `rgba(255,255,255,0.1)`  | `--border`             |
| `--border-muted`         | `rgba(0,0,0,0.05)`     | `rgba(255,255,255,0.05)` | _(custom, keep)_       |
| `--input`                | `#ffffff`              | `#1a1a1a`                | `--input`              |
| `--ring`                 | `#8b7355`              | `#a68b6a`                | `--ring`               |
| `--success`              | `#28c840`              | `#28c840`                | _(custom, keep)_       |
| `--success-muted`        | `rgba(40,200,64,0.1)`  | `rgba(40,200,64,0.1)`    | _(custom, keep)_       |

**Tokens we need to add for shadcn compatibility:**

| Token                      | Purpose                      | Suggested value (light) | Suggested value (dark)   |
| -------------------------- | ---------------------------- | ----------------------- | ------------------------ |
| `--popover`                | Popover/dropdown backgrounds | `#ffffff`               | `#252525`                |
| `--popover-foreground`     | Popover text                 | `#1a1a1a`               | `#f8f8f6`                |
| `--secondary`              | Secondary button/element bg  | `rgba(0,0,0,0.05)`      | `rgba(255,255,255,0.05)` |
| `--secondary-foreground`   | _(already exists)_           | —                       | —                        |
| `--destructive`            | Destructive actions          | `#dc2626`               | `#ef4444`                |
| `--destructive-foreground` | Text on destructive bg       | `#ffffff`               | `#ffffff`                |
| `--radius`                 | Default border radius        | `0.25rem`               | `0.25rem`                |

> **Note on `--radius`:** Our current design is minimal/sharp-edged. We use `rounded-sm` (0.125rem)
> in some places and no rounding in others. Setting `--radius` to `0.25rem` keeps things subtle.
> This can be tuned after initial integration.

### Existing components

| Component   | File                                  | Lines | Notes                                                                                                                |
| ----------- | ------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------- |
| `Button`    | `src/components/ui/button.tsx`        | 52    | Variants: primary, outline, ghost, destructive, subtle. Has `buttonVariants()` helper used standalone on `<a>` tags. |
| `Badge`     | `src/components/ui/badge.tsx`         | 40    | Variants: default, pr-merged, pr-closed, pr-draft, pr-open, info, kbd. Has `prBadgeVariant()` helper.                |
| `Combobox`  | `src/components/ui/combobox.tsx`      | 361   | Generic `<T>`, grouped options, custom keyboard nav, direction prop, prependContent render prop.                     |
| `Select`    | `src/components/ui/form-controls.tsx` | 30    | Native `<select>` wrapper with custom chevron icon.                                                                  |
| `RadioCard` | `src/components/ui/form-controls.tsx` | 35    | Styled radio input as a card.                                                                                        |

### Dependencies

Current UI-related deps: none beyond React, Next.js, and Tailwind. No Radix, no `clsx`, no
`tailwind-merge`, no `class-variance-authority`.

---

## Implementation Plan

### Phase 0: Prerequisites & Foundation

**Goal:** Install tooling, add `cn()` utility, configure shadcn, and set up class-based dark mode —
without changing any existing component behavior.

#### 0.1 Install base dependencies

```bash
npm install -w @open-inspect/web clsx tailwind-merge class-variance-authority
npm install -D -w @open-inspect/web @radix-ui/react-slot
```

> `@radix-ui/react-slot` is needed for shadcn's `Button` `asChild` pattern. Additional `@radix-ui/*`
> packages are installed per-component in Phase 2+.

#### 0.2 Add `cn()` utility

Create `src/lib/utils.ts`:

```ts
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

#### 0.3 Switch to class-based dark mode

**`tailwind.config.ts`** — change `darkMode`:

```ts
darkMode: "class",
```

**`globals.css`** — the `.dark` selector already exists and duplicates the
`@media (prefers-color-scheme: dark)` block. After switching to class-based:

1. Keep the `@media (prefers-color-scheme: dark)` block as a fallback for no-JS / initial load.
2. The `.dark` class block (already present) becomes the authoritative source.

**`src/app/layout.tsx`** — install `next-themes` and wrap the app:

```bash
npm install -w @open-inspect/web next-themes
```

Update the `Providers` component to include `ThemeProvider`:

```tsx
import { ThemeProvider } from "next-themes";

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <SWRConfig ...>
        <SessionProvider ...>
          {children}
        </SessionProvider>
      </SWRConfig>
    </ThemeProvider>
  );
}
```

Update `layout.tsx` to add `suppressHydrationWarning` to `<html>` (required by `next-themes`):

```tsx
<html lang="en" suppressHydrationWarning>
```

> **No theme toggle UI is required at this stage.** With `defaultTheme="system"` and `enableSystem`,
> behavior is identical to the current `prefers-color-scheme` approach. A toggle can be added later
> as a separate enhancement.

#### 0.4 Initialize shadcn

```bash
npx shadcn@latest init
```

This creates `components.json` at the package root. Configure it to match our setup:

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": true,
  "tsx": true,
  "tailwind": {
    "config": "tailwind.config.ts",
    "css": "src/app/globals.css",
    "baseColor": "neutral",
    "cssVariables": true,
    "prefix": ""
  },
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "hooks": "@/hooks",
    "lib": "@/lib"
  }
}
```

#### 0.5 Add missing CSS tokens

Add to both the `:root`, `@media (prefers-color-scheme: dark)`, and `.dark` blocks in `globals.css`:

```css
/* Light */
--popover: #ffffff;
--popover-foreground: #1a1a1a;
--secondary: rgba(0, 0, 0, 0.05);
--destructive: #dc2626;
--destructive-foreground: #ffffff;
--radius: 0.25rem;

/* Dark */
--popover: #252525;
--popover-foreground: #f8f8f6;
--secondary: rgba(255, 255, 255, 0.05);
--destructive: #ef4444;
--destructive-foreground: #ffffff;
```

Add corresponding entries to `tailwind.config.ts`:

```ts
popover: "var(--popover)",
"popover-foreground": "var(--popover-foreground)",
secondary: "var(--secondary)",
destructive: "var(--destructive)",
"destructive-foreground": "var(--destructive-foreground)",
```

Add border radius config:

```ts
borderRadius: {
  lg: "calc(var(--radius) * 2)",
  md: "var(--radius)",
  sm: "calc(var(--radius) / 2)",
},
```

#### 0.6 Verify

- `npm run build -w @open-inspect/web` passes
- `npm run typecheck -w @open-inspect/web` passes
- `npm run test -w @open-inspect/web` passes
- Visual check: light and dark mode look identical to before

---

### Phase 1: Migrate Existing Components

**Goal:** Replace hand-rolled primitives with shadcn equivalents, preserving all current variants
and behavior.

#### 1.1 Button

**Install:** No additional deps needed (`@radix-ui/react-slot` installed in Phase 0).

**Add component:** `npx shadcn@latest add button`

**Customization needed:**

- Port our variants: `primary`, `outline`, `ghost`, `destructive`, `subtle`
- Port our sizes: `default`, `sm`, `xs`, `icon`
- The `primary` variant should use `bg-accent` (warm brown), not shadcn's default `bg-primary`
  (black/white). Map carefully.
- Keep the `buttonVariants()` export — it's used by `action-bar.tsx` to style `<a>` tags

**Migration steps:**

1. Generate shadcn Button to a temp location, then merge variant definitions into our existing file
2. Update `buttonVariants` to use `cva` from `class-variance-authority`
3. Add `asChild` prop support via `@radix-ui/react-slot` (replaces the `buttonVariants()` on `<a>`
   pattern)
4. Update all 15+ import sites — API should remain compatible (`variant`, `size`, `className` props
   unchanged)

**Variant mapping:**

| Our variant   | shadcn equivalent | Classes                                                                                            |
| ------------- | ----------------- | -------------------------------------------------------------------------------------------------- |
| `primary`     | `default`         | `bg-accent text-accent-foreground hover:bg-accent/90`                                              |
| `outline`     | `outline`         | `border border-border text-foreground hover:bg-muted`                                              |
| `ghost`       | `ghost`           | `text-muted-foreground hover:text-foreground hover:bg-muted`                                       |
| `destructive` | `destructive`     | `text-red-600 hover:text-red-700 hover:bg-red-50` (keep our style, not shadcn's filled-bg default) |
| `subtle`      | _(custom)_        | `text-secondary-foreground hover:text-foreground`                                                  |

#### 1.2 Badge

**Install:** No additional deps.

**Add component:** `npx shadcn@latest add badge`

**Customization needed:**

- Port all PR-state variants (`pr-merged`, `pr-closed`, `pr-draft`, `pr-open`, `info`, `kbd`)
- Keep the `prBadgeVariant()` helper function

This is a low-risk migration — Badge is simple and our variants are additive.

#### 1.3 Select (native → Radix)

**Install:** `@radix-ui/react-select`

**Add component:** `npx shadcn@latest add select`

**Customization needed:**

- Port `density` prop (`"default"` | `"compact"`) as custom sizes
- Our current `Select` is a native `<select>` wrapper — the API changes significantly (from
  `<Select><option>` to `<Select><SelectTrigger><SelectContent><SelectItem>`)
- Update all consumers to use the new compound-component API

**Migration steps:**

1. Add shadcn Select component
2. Create a migration checklist of all `<Select>` usage sites
3. Update each consumer, preserving existing styling and behavior
4. Remove the native Select from `form-controls.tsx`

#### 1.4 Combobox — defer migration

The existing Combobox is 361 lines with specific features (generic typing, grouped options,
direction prop, prependContent render prop) that don't map cleanly to shadcn's Command + Popover
pattern. **Defer this migration** until the team is comfortable with the new primitives. It works
correctly today and has good accessibility.

The Combobox can be revisited as a follow-up when there's a concrete need to extend it or when we
need the Command component for other features (e.g., command palette).

#### 1.5 RadioCard — keep as-is

`RadioCard` has no shadcn equivalent. It's a domain-specific component that's well-implemented. Keep
it in `form-controls.tsx` (or move to its own file for consistency).

---

### Phase 2: Add New Primitives

Add components incrementally as needed. Prioritized by current UI needs:

#### High priority (fill existing gaps in the UI)

| Component        | Radix package                   | Use case                                                                       |
| ---------------- | ------------------------------- | ------------------------------------------------------------------------------ |
| **Dialog**       | `@radix-ui/react-dialog`        | Confirmation modals (archive session, delete secrets, disconnect integrations) |
| **DropdownMenu** | `@radix-ui/react-dropdown-menu` | Action menus (copy link, share, more actions)                                  |
| **Input**        | _(none, pure Tailwind)_         | Text inputs (secrets editor, session prompt, search fields)                    |
| **Textarea**     | _(none, pure Tailwind)_         | Multi-line inputs (session prompt)                                             |
| **Tooltip**      | `@radix-ui/react-tooltip`       | Icon button labels, truncated text                                             |

#### Medium priority (improve UX)

| Component          | Radix package            | Use case                                                  |
| ------------------ | ------------------------ | --------------------------------------------------------- |
| **Tabs**           | `@radix-ui/react-tabs`   | Settings page sections                                    |
| **Sheet**          | `@radix-ui/react-dialog` | Mobile sidebar (replace custom implementation)            |
| **Toast / Sonner** | `sonner`                 | Success/error feedback (copy to clipboard, save settings) |
| **Switch**         | `@radix-ui/react-switch` | Boolean settings toggles                                  |

#### Lower priority (as UI expands)

| Component       | Radix package                  | Use case                                                              |
| --------------- | ------------------------------ | --------------------------------------------------------------------- |
| **AlertDialog** | `@radix-ui/react-alert-dialog` | Destructive action confirmations                                      |
| **Popover**     | `@radix-ui/react-popover`      | Rich tooltips, inline forms                                           |
| **Accordion**   | `@radix-ui/react-accordion`    | Collapsible sections (could replace custom `collapsible-section.tsx`) |
| **Checkbox**    | `@radix-ui/react-checkbox`     | Multi-select lists                                                    |
| **Separator**   | `@radix-ui/react-separator`    | Visual dividers                                                       |
| **ScrollArea**  | `@radix-ui/react-scroll-area`  | Custom scrollbar styling                                              |

Each component is added with:

```bash
npx shadcn@latest add <component-name>
```

Then customized to match our design tokens (colors, border radius, font).

---

### Phase 3: Optional Enhancements

These are not required but are natural follow-ups:

- **Theme toggle** — now trivial with `next-themes` already installed. Add a sun/moon button in the
  sidebar or settings.
- **Command palette** (cmdk) — `npx shadcn@latest add command`. Keyboard shortcut to search
  sessions, navigate, run actions.
- **Storybook or component catalog** — useful if the team grows. Not needed now.

---

## Design Preservation Strategy

### Colors

Our warm brown accent (`#8b7355` / `#a68b6a`) and neutral palette are preserved through CSS
variables. shadcn components reference the same token names (`--accent`, `--primary`, etc.), so
they'll automatically pick up our colors. No component-level color overrides needed.

### Typography

Geist Sans / Geist Mono fonts are set via CSS variables and `globals.css`. shadcn components inherit
`font-family` from the body — no changes needed.

### Spacing and density

Our UI is relatively compact. After adding shadcn components, review padding/margins and adjust if
components feel too spacious. The `new-york` style variant (vs. `default`) is already more compact
and closer to our aesthetic.

### Border radius

Setting `--radius: 0.25rem` keeps the sharp/minimal look. shadcn's `rounded-md` will resolve to
`0.25rem`, and `rounded-sm` to `0.125rem`. This matches our current style.

### Focus styles

Our current global focus style (`*:focus-visible { outline: 2px solid var(--ring) }`) will coexist
with Radix's focus management. Radix components use `data-[state=*]` attributes for styling, which
shadcn maps to Tailwind classes. Our `--ring` color (warm brown) will be used for focus indicators.

---

## Risks and Mitigations

| Risk                                     | Likelihood | Impact | Mitigation                                                                                                                                           |
| ---------------------------------------- | ---------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| React 19 compatibility issues with Radix | Low        | Medium | Radix has resolved most React 19 issues. Pin to latest stable versions. Test thoroughly.                                                             |
| Bundle size increase                     | Low        | Low    | Each Radix primitive adds ~3-8KB gzip. Total for high-priority components: ~20-30KB. Tree-shaking keeps unused code out.                             |
| Select API change breaks consumers       | Medium     | Medium | The shift from native `<select>` to Radix compound components changes the API. Create a migration checklist and update all consumers in a single PR. |
| Combobox migration complexity            | High       | Medium | Deferred. Keep existing implementation. Revisit when there's a concrete need.                                                                        |
| Dark mode flash on initial load          | Low        | Low    | `next-themes` handles this with a script injected into `<head>`. The `@media` fallback in `globals.css` provides additional protection.              |
| Styling drift from our design            | Low        | Medium | All shadcn components are source-owned. Customize at install time. Review each component's styles against our design before merging.                 |

---

## Estimated Effort

| Phase                         | Scope                                                   | Effort      |
| ----------------------------- | ------------------------------------------------------- | ----------- |
| **Phase 0**                   | Foundation (deps, cn(), dark mode, shadcn init, tokens) | ~2-3 hours  |
| **Phase 1**                   | Migrate Button, Badge, Select                           | ~3-4 hours  |
| **Phase 2 (high priority)**   | Dialog, DropdownMenu, Input, Textarea, Tooltip          | ~3-4 hours  |
| **Phase 2 (medium priority)** | Tabs, Sheet, Toast, Switch                              | ~2-3 hours  |
| **Phase 2 (lower priority)**  | Remaining components, as needed                         | Incremental |
| **Phase 3**                   | Theme toggle, command palette                           | Optional    |

**Total for Phases 0-2 (high priority): ~8-11 hours**

---

## File Changes Summary

### New files

| File                                  | Purpose              |
| ------------------------------------- | -------------------- |
| `src/lib/utils.ts`                    | `cn()` utility       |
| `components.json`                     | shadcn configuration |
| `src/components/ui/dialog.tsx`        | shadcn Dialog        |
| `src/components/ui/dropdown-menu.tsx` | shadcn DropdownMenu  |
| `src/components/ui/input.tsx`         | shadcn Input         |
| `src/components/ui/textarea.tsx`      | shadcn Textarea      |
| `src/components/ui/tooltip.tsx`       | shadcn Tooltip       |
| _(+ additional components as added)_  |                      |

### Modified files

| File                                  | Change                                                         |
| ------------------------------------- | -------------------------------------------------------------- |
| `package.json`                        | Add deps: clsx, tailwind-merge, cva, next-themes, @radix-ui/\* |
| `tailwind.config.ts`                  | `darkMode: "class"`, add tokens, add borderRadius              |
| `src/app/globals.css`                 | Add new CSS tokens (popover, secondary, destructive, radius)   |
| `src/app/layout.tsx`                  | Add `suppressHydrationWarning` to `<html>`                     |
| `src/app/providers.tsx`               | Wrap with `ThemeProvider`                                      |
| `src/components/ui/button.tsx`        | Rewrite with cva + Radix Slot                                  |
| `src/components/ui/badge.tsx`         | Rewrite with cva                                               |
| `src/components/ui/form-controls.tsx` | Remove native Select (moved to shadcn), keep RadioCard         |

### Unchanged files

| File                                                                   | Reason                                             |
| ---------------------------------------------------------------------- | -------------------------------------------------- |
| `src/components/ui/combobox.tsx`                                       | Migration deferred                                 |
| `src/components/ui/icons.tsx`                                          | No changes needed                                  |
| All feature components (`action-bar.tsx`, `session-sidebar.tsx`, etc.) | Updated only where they consume changed primitives |

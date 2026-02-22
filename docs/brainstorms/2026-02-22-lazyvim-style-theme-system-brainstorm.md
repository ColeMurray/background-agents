---
date: 2026-02-22
topic: lazyvim-style-theme-system
---

# LazyVim-Style Theme System for Web App

## What We're Building

We are redesigning the web app visual style to feel like a polished, editor-inspired interface
modeled after LazyVim aesthetics. Tokyo Night will be the default theme, and users will be able to
switch to Catppuccin, Gruvbox, Kanagawa, and One Dark.

This is a full reskin, not a palette tweak. The refresh covers core surfaces, typography tone,
component hierarchy, borders, states, and markdown/code presentation so the app feels cohesive
end-to-end. Theme selection will be managed in Settings (no global header toggle in v1) and
persisted server-side per user account for cross-device consistency.

## Why This Approach

We chose a token-driven multi-theme architecture because it best supports both immediate visual
quality and long-term maintainability. The current app already uses semantic CSS variables in key
areas, which creates a strong base for standardizing tokens and removing hardcoded color drift
across components.

Compared with class-heavy per-theme styling, a token-first system reduces duplication and keeps
future theme additions predictable. Compared with a staged single-theme rollout, building
multi-theme capability now avoids rework and ensures the full reskin is designed from the start for
consistent cross-theme behavior.

## Key Decisions

- **Default theme is Tokyo Night**: Sets the visual identity baseline and anchors design decisions.
- **Theme switching ships in v1**: Include Catppuccin, Gruvbox, Kanagawa, and One Dark from the
  first release.
- **Settings-only theme control**: Keep UX simple and avoid adding another always-visible global
  control.
- **Server-side persistence**: Store preference per user account so theme follows the user across
  devices.
- **Full reskin scope**: Refresh component styling holistically instead of applying narrow palette
  overrides.
- **Token-driven theming model**: Normalize app styling around semantic tokens for consistency and
  scalability.

## Resolved Questions

- **How far should this pass go?** Full UI reskin.
- **Which style family should anchor the design?** Tokyo Night.
- **Should users be able to switch themes?** Yes.
- **Which themes should v1 include?** Catppuccin, Gruvbox, Kanagawa, One Dark.
- **Where should theme controls live?** Settings page only.
- **How is preference stored?** Server-side per user account.

## Open Questions

None currently.

## Next Steps

-> Run `/workflows:plan` to define implementation steps, file-level changes, migration strategy for
existing styles, and test/verification criteria.

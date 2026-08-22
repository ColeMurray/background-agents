# Research: Configurable per-user keyboard shortcuts

**Date:** 2026-08-22 **Status:** Research only **Scope:** Current keyboard shortcut behavior,
display surfaces, user identity, preference persistence, and relevant test coverage.

This document is intentionally research-only. It does not include recommendations, implementation
plans, proposed code/API/schema changes, task breakdowns, estimates, or rollout steps.

## Summary

The authenticated web application advertises four keyboard shortcuts: send prompt, command menu, new
session, and toggle sidebar. Three global shortcuts are matched by a shared utility and registered
by the authenticated sidebar layout. Send-prompt matching is implemented separately in the home
composer and session composer. The Keyboard settings page displays fixed labels and has no controls
or persistence.

The application has no generic canonical-user preferences record. Existing web-managed per-user
data, most notably managed-skill profiles, is stored in D1 under the canonical `users.id`,
owner-scoped in control-plane stores and routes, proxied through authenticated Next.js API routes,
and fetched by authenticated SWR hooks. Several UI preferences use `localStorage`, but those values
are browser-origin scoped and are not isolated by the authenticated user.

## Research Questions

1. Where are keyboard shortcuts defined, matched, registered, and displayed?
2. How does the application currently persist settings for a canonical web user?
3. Which behavioral and ownership guarantees are covered by existing tests?

## Current Behavior

`packages/web/src/lib/keyboard-shortcuts.ts` contains fixed display labels for all four advertised
shortcuts. It also matches three global actions:

- `Cmd/Ctrl+K` opens or closes the command menu.
- `Cmd/Ctrl+Shift+O` navigates to a new session.
- `Cmd/Ctrl+/` toggles the sidebar.

The global matcher requires Meta or Control, rejects Alt, checks K and O through
`KeyboardEvent.key`, and checks Slash through `KeyboardEvent.code`. It does not inspect key repeat
or require exactly one of Meta and Control.

`packages/web/src/hooks/use-global-shortcuts.ts` installs one `window` `keydown` listener. The
listener is mounted by `SidebarLayout` within the authenticated application layout. Accepted events
are prevented before their action callback runs. Command-menu events are allowed from editable
controls; new-session and sidebar events are ignored from inputs, textareas, selects, and
content-editable elements. Composing and already-prevented events are ignored.

Send prompt is not a global action. `HomeContent` in `packages/web/src/app/(app)/page.tsx` and
`usePromptInput` in `packages/web/src/hooks/use-prompt-input.ts` independently recognize
Meta/Control+Enter without Shift or Alt. Both reject IME composition. The session path also applies
its ordinary submission-readiness guards.

`KeyboardShortcutsSettings` displays four badge rows and composer help text. It has no input
controls, save/reset behavior, loading state, authenticated data access, or error state. Fixed
shortcut labels also appear in button titles, accessible labels, settings navigation controls, and
the global command menu.

## Relevant Workflows

### Global shortcut dispatch

The authenticated app layout mounts `SidebarLayout`, which calls `useGlobalShortcuts`. The hook
matches the event, applies the editable-element policy, prevents the browser default, and invokes
the command-menu, navigation, or sidebar callback.

### Prompt submission

The home and in-session textareas receive local React keyboard handlers. Managed-skill autocomplete
consumes unmodified navigation and selection keys while forwarding modified Enter to the parent
submission handler.

### Canonical browser identity

Better Auth stores browser users directly in the canonical `users` table. Browser API requests carry
an opaque session cookie through the web BFF. The control plane validates the signed web-service
channel and Better Auth session, then exposes the canonical user ID as a user principal.

### Canonical per-user settings

Managed-skill profiles are the clearest existing canonical-user settings workflow. Their D1 rows
contain `user_id`; store reads and writes include that owner; routes derive the owner from the
authenticated principal; response types omit the owner; Next.js API routes use `settingsProxy`; and
an authenticated SWR hook validates responses before exposing them to settings forms.

### Browser-local preferences

Appearance, model selection, provider selection, target selection, diff display, sidebar state, and
related interface choices are stored in `localStorage`. Their keys do not contain a canonical user
ID. A second user of the same browser origin observes the same stored values.

## Existing Patterns

- Shared request and response contracts use Zod schemas in `packages/shared/src/types`.
- Shared package subpaths are explicitly listed in `packages/shared/package.json` and are built
  before dependent packages.
- Authenticated settings BFF routes use `settingsProxy` to forward JSON requests and the browser
  session to control-plane resources.
- Control-plane route handlers parse request bodies, validate shared schemas, derive user ownership
  from the principal, and return JSON errors with explicit status codes.
- D1 integration tests apply every migration and clean shared tables between tests.
- Web settings forms commonly use authenticated SWR data, local editing state, disabled save
  controls, and Sonner success/error notifications.
- Shortcut labels are reused across settings, command-menu, button-title, and accessible label
  surfaces.

## Constraints and Invariants

- Canonical user IDs are 32-character lowercase hexadecimal identifiers.
- Protected browser resources require both signed web-service authentication and a valid Better Auth
  browser session.
- The settings proxy caps JSON mutation bodies at 4 MiB.
- Global new-session and sidebar shortcuts are suppressed in editable elements; the command-menu
  shortcut remains available there.
- Prompt submission remains local to composer controls and is subject to submission state.
- IME composition suppresses advertised shortcut actions.
- D1 migrations are sequential; the current latest migration is `0066`.
- There is no generic user-preferences table or JSON preference column.
- The model-preferences resource is a workspace-global singleton despite its name.

## Known Gaps and Risks

- Display labels and event matching are separate fixed representations.
- Prompt submission matching is duplicated between the home and session composers.
- The Keyboard settings surface is informational rather than editable.
- No current persistence resource stores keyboard shortcut choices.
- No global-hook test dispatches window keyboard events or verifies listener cleanup.
- Existing central matcher tests do not cover every editable element, event repetition, simultaneous
  Meta and Control, or non-US keyboard layouts.
- The home page tests do not directly assert modified-Enter submission.
- Fixed shortcut labels are distributed across multiple UI surfaces.
- Existing browser-local settings do not provide per-user isolation.
- The available Git history is shallow; the original shortcut-system commit predates the visible
  history boundary.

## Open Questions

- Internal evidence does not explain whether physical `Slash` matching rather than character
  matching is intentional.
- Internal evidence does not define behavior for shortcut combinations reserved by the browser or
  operating system before page JavaScript receives them.
- Internal evidence does not state whether simultaneous Meta and Control acceptance is intentional.
- No current product text defines collision handling for user-selected shortcuts.
- No current product text defines whether every advertised action must retain a binding.

## Evidence

- `packages/web/src/lib/keyboard-shortcuts.ts`: fixed labels, global action identifiers, matching
  rules, and editable-element policy.
- `packages/web/src/hooks/use-global-shortcuts.ts`: authenticated global listener and callback
  dispatch.
- `packages/web/src/components/sidebar-layout.tsx`: registration scope and global action callbacks.
- `packages/web/src/app/(app)/page.tsx`: home composer matching and shortcut display.
- `packages/web/src/hooks/use-prompt-input.ts`: in-session composer matching and guards.
- `packages/web/src/components/settings/keyboard-shortcuts-settings.tsx`: read-only Keyboard
  settings surface.
- `packages/web/src/components/prompt-skill-autocomplete.tsx`: contextual key handling and
  forwarding of modified Enter.
- `packages/web/src/lib/auth-session.tsx`: browser session state.
- `packages/control-plane/src/auth/authenticate.ts`: authenticated principal construction.
- `terraform/d1/migrations/0057_reconcile_canonical_auth_identities.sql`: canonical Better Auth
  identity storage.
- `terraform/d1/migrations/0061_managed_skills.sql`: canonical-user skill-profile rows.
- `packages/control-plane/src/db/skill-profiles.ts`: owner-scoped D1 store behavior.
- `packages/control-plane/src/routes/skills.ts`: principal-derived user ownership and route
  validation.
- `packages/web/src/lib/settings-proxy.ts`: authenticated settings BFF behavior.
- `packages/web/src/hooks/use-managed-skills.ts`: authenticated SWR and response validation.
- `packages/web/src/lib/keyboard-shortcuts.test.ts`: current matcher-policy coverage.
- `packages/control-plane/test/integration/managed-skills.test.ts`: existing D1 integration testing
  patterns.

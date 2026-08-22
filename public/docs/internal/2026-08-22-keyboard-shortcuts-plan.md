# Plan: Configurable per-user keyboard shortcuts

**Date:** 2026-08-22 **Status:** Implementation plan **Research:**
`public/docs/internal/2026-08-22-keyboard-shortcuts-research.md`

## Goal

Allow each authenticated web user to record, save, use, and reset the four advertised keyboard
shortcuts. Saved bindings follow the user across browsers and do not affect any other user.

## Product Behavior

- The Keyboard settings page exposes one recorder for each action: send prompt, command menu, new
  session, and toggle sidebar.
- Activating a recorder and pressing a valid combination replaces that row's draft value.
- Escape cancels recording without changing the draft.
- Standalone modifier presses are ignored while recording.
- A valid shortcut contains a primary modifier (Meta or Control, represented portably as `Cmd/Ctrl`)
  or Alt, plus one non-modifier key. Shift remains an optional modifier.
- Bindings are represented by `KeyboardEvent.code`, so selection and matching refer to the same
  physical key across keyboard layouts. Human-readable labels translate common codes such as
  `Enter`, `Slash`, `Space`, arrow keys, letters, and digits.
- The four actions must have distinct bindings. Duplicate draft bindings are identified inline and
  cannot be saved. The server independently rejects duplicate bindings.
- Save persists the complete set atomically for the authenticated canonical user.
- Reset to defaults updates the draft to the shipped defaults; the user then saves that draft
  through the same persistence path.
- Until preferences load, or when a user has no saved row, shipped defaults remain active.
- A failed preference read leaves defaults active and surfaces an error on the settings screen. A
  failed save leaves the draft intact and reports the failure.
- Updated bindings drive runtime matching and every existing displayed shortcut label, including
  button titles, accessible labels, command-menu hints, and composer help text.
- Existing focus rules remain unchanged: command menu works from editable controls; new session and
  sidebar toggle do not; send prompt only operates in composer controls.
- Existing IME and submission-readiness behavior remains unchanged.

## Data Contract

Add a shared keyboard-shortcut contract with:

- Four stable action IDs: `send-prompt`, `open-command-menu`, `new-session`, and `toggle-sidebar`.
- A binding shape containing `code`, `primary`, `alt`, and `shift`.
- A complete action-to-binding record.
- Shipped defaults matching current behavior.
- Zod request and response schemas that require every action, reject unknown fields, require a
  primary or Alt modifier, reject modifier-only codes, and reject duplicates.

The shared package exposes this contract through a dedicated package export. It is built before
control-plane and web verification.

## Persistence And API

Add the next sequential D1 migration with one `keyboard_shortcut_preferences` row per canonical
user:

- `user_id` is the primary key and references `users(id)` with cascade deletion.
- The complete validated shortcut record is stored as JSON.
- `updated_at` records the latest successful write.

Add a small control-plane store:

- `get(userId)` returns the validated saved record or shipped defaults when absent.
- `set(userId, shortcuts)` atomically upserts the complete record.
- Invalid persisted JSON is treated as an internal data error rather than being exposed as trusted
  configuration.

Add authenticated `GET` and `PUT` `/keyboard-shortcuts` routes:

- Both require a canonical user principal.
- GET returns `{ shortcuts }`.
- PUT validates `{ shortcuts }`, replaces only the current user's row, and returns the persisted
  `{ shortcuts }`.
- Invalid payloads return 400 and missing canonical identity returns 403.

Register the route set in the control-plane router. Add a same-origin `/api/keyboard-shortcuts`
Next.js route using `settingsProxy` for GET and PUT.

## Web Runtime

Refactor `packages/web/src/lib/keyboard-shortcuts.ts` so one binding model drives:

- Event capture from `KeyboardEvent`.
- Canonical equality and duplicate detection.
- Human-readable labels.
- Matching a keyboard event to an action.
- Existing editable-target ignore behavior.

Add an authenticated SWR hook for `/api/keyboard-shortcuts`:

- Parse responses with the shared schema.
- Return defaults while loading or on failure so shortcuts always remain usable.
- Expose labels and bindings to consumers.
- Expose a save helper that updates the shared SWR cache with the server response.

Thread the resolved bindings through both execution paths:

- `useGlobalShortcuts` matches the three global actions against current user bindings.
- Home and session composer handlers match `send-prompt` through the same central matcher.

Replace all imports of fixed `SHORTCUT_LABELS` with labels derived from the hook in:

- `sidebar-layout.tsx`
- `session-sidebar.tsx`
- `global-command-menu.tsx`
- `app/(app)/settings/page.tsx`
- `app/(app)/page.tsx`
- `session-prompt-composer.tsx`
- `keyboard-shortcuts-settings.tsx`

## Settings UI

Replace the read-only badge list with an editable form that follows existing settings styling:

- Rows contain action name, short behavior description, and a button-like recorder showing the
  current draft label or `Press shortcut` while active.
- Recording uses `onKeyDown`, prevents captured combinations from invoking global or browser
  handlers, and makes recording state clear through visible text and focus styling.
- Duplicate rows render an inline error and invalid drafts disable Save.
- Save is disabled while unchanged, invalid, loading, or saving.
- Reset to defaults is disabled when the draft already equals defaults.
- Successful save clears dirty state and shows a success toast.
- Fetch/save errors render actionable text or a toast while retaining usable defaults and unsaved
  draft values.
- Composer explanatory text uses the current send-prompt label.

## TDD Sequence

1. Add failing shared contract tests for complete records, modifier requirements, unknown
   actions/fields, duplicate rejection, and defaults; implement the schemas and export.
2. Add failing control-plane integration tests for default GET, valid PUT/GET round trip, invalid
   and duplicate payload rejection, and isolation between two canonical users; implement migration,
   cleanup, store, routes, and router registration.
3. Add failing web utility tests for capture, formatting, equality, configured matching, default
   matching, IME behavior, and editable-target policy; refactor the utility.
4. Add failing hook tests for authenticated fetching, default fallback, schema rejection, and cache
   update after save; implement the SWR hook and BFF route.
5. Add failing settings component tests for recording, Escape cancellation, duplicate validation,
   reset, successful save, and failed save; implement the form.
6. Extend failing home/session/global shortcut tests to prove custom bindings dispatch the correct
   actions and defaults still work; update all runtime consumers.
7. Add or update label-surface tests to prove saved labels appear in settings, controls,
   command-menu hints, and composer accessibility text.

Each stage begins with the focused failing test, adds the minimum implementation to pass, and reruns
the focused suite before proceeding.

## Verification

Run focused checks throughout TDD, then run:

```bash
npm run build -w @open-inspect/shared
npm test -w @open-inspect/shared
npm test -w @open-inspect/control-plane
npm run test:integration -w @open-inspect/control-plane
npm test -w @open-inspect/web
npm run typecheck
npm run lint
```

Inspect the final diff for migration ordering, route authentication, user-ID scoping, schema reuse,
fixed-label leftovers, and unintended changes. Perform a strict thermo-review in a separate
sub-agent, resolve every actionable finding, and rerun affected tests plus the full verification
commands before committing and opening the pull request.

## Acceptance Criteria

- An authenticated user can record and save all four shortcuts from Keyboard settings.
- The saved values take effect without a page reload.
- Reloading or signing in on another browser restores that user's values.
- A different user receives defaults or their own saved values, never the first user's.
- Duplicate or malformed bindings cannot be persisted.
- Resetting and saving restores the shipped defaults.
- Every shortcut display surface reflects the active saved binding.
- Global editable-field, IME, and prompt submission guards retain their existing behavior.
- Shared, control-plane, integration, web, typecheck, and lint verification pass.
- The thermo-review has no unresolved actionable findings.

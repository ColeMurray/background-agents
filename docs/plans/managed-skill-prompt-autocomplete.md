# Managed Skill Prompt Autocomplete

## Status

Proposed implementation plan for V1.

## Summary

Add frontend-only managed-skill autocomplete to both web prompt composers. Typing `/` or `$` at a
token boundary opens a list of skills available to that prompt. Selecting a result inserts the
corresponding text, such as `$review-pr`, into the textarea.

V1 does not give the token application-defined invocation semantics. The completed prompt continues
through the existing HTTP or WebSocket path as plain text, and Open-Inspect does not parse, resolve,
or transform the reference after submission.

## V1 Decisions

| Area                    | Decision                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------- |
| Prompt surfaces         | Support the new-session composer and existing-session follow-up composer.               |
| Trigger syntax          | Support both `/skill-name` and `$skill-name`; preserve the trigger the user typed.      |
| Meaning after insertion | Plain prompt text only. No direct skill invocation or prompt-transport metadata.        |
| New-session source      | Use the current resolution preview for the selected target and skill selection.         |
| Follow-up source        | Use the immutable skills pinned to the existing session.                                |
| Matching                | Case-insensitive skill-name prefix matching; names are already canonical lowercase.     |
| Popup position          | Anchor above both composers, not at exact on-screen caret coordinates.                  |
| Selection               | Mouse, touch, ArrowUp/ArrowDown, unmodified Enter, or Tab.                              |
| Dismissal               | Escape, invalid token text, moving outside the token, selection changes, or focus loss. |
| Submission shortcut     | Preserve Cmd/Ctrl+Enter, including while the autocomplete is open.                      |
| Empty/error state       | Keep the panel open and show loading, unavailable, or no-match feedback.                |

## User Experience

1. The user types `/` or `$` either at the beginning of the prompt or immediately after whitespace.
2. The composer opens a list of available skills, showing the typed trigger, skill name, and
   description.
3. Additional valid skill-name characters filter the list by name prefix.
4. Arrow keys move the active result without moving the textarea caret. Mouse and touch can also
   choose a result without transferring focus away from the textarea.
5. Enter or Tab replaces the active token with the selected reference. Escape closes the list
   without changing the prompt.
6. The inserted reference remains ordinary editable text and is submitted unchanged with the rest of
   the prompt.

The list opens for an empty query because each session can contain at most 20 managed skills. The
active result starts at the first matching skill, using the deterministic order returned by skill
resolution.

## Token Contract

Keep token detection and replacement in a pure web utility so both composers have identical behavior
and edge cases can be tested without rendering a page.

An active completion token has these properties:

- The textarea selection is collapsed.
- The caret is inside or immediately after a token beginning with `/` or `$`.
- The trigger is at offset zero or preceded by whitespace.
- Text between the trigger and caret contains only ASCII letters, numbers, and hyphens. Matching
  normalizes ASCII letters because managed-skill names are canonical lowercase.
- Input method editor composition is not active.

The parser scans from the caret back to the trigger and forward to the end of the current
skill-name-shaped token. This gives selection a complete replacement range even when the user moves
the caret into an existing partial reference. The boundary rule avoids treating embedded URL/path
segments or mid-word dollar text as skill completion triggers.

Selection replaces that full range with the original trigger plus the canonical skill name. Append
one space only when the token ends at the end of the prompt; preserve existing whitespace,
punctuation, and all text outside the replacement range. Restore the caret immediately after the
inserted reference or appended space.

## Skill Sources

### New-session composer

The authoritative suggestion set is the output of `resolveSkillPreview()` for the current target and
`skillSelection`:

- It excludes disabled and soft-deleted skills.
- It applies global, repository, and environment assignments.
- It applies the selected profile or the built-in All/None mode.
- It returns the same `ResolvedSkill` names and descriptions that session creation will pin.

Move ownership of resolution preview from `SessionSkillSelector` to the home page through a reusable
hook in `use-managed-skills.ts`. The hook accepts the preview target and selection, aborts stale
requests, and exposes the full response plus loading/error state. Pass the same result to:

- `SessionSkillSelector`, which continues to render resolved and ignored counts.
- The new prompt autocomplete, which uses `result.skills` as suggestions.

This avoids duplicate requests and prevents the selector count from diverging from autocomplete.
Until the target is valid and the preview succeeds, the prompt remains fully usable but has no skill
suggestions. Selecting an autocomplete result does not modify `skillSelection`, so it does not
invalidate or recreate a warmed session.

### Follow-up composer

Call `useSessionSkills(sessionId)` from the session page and pass `provenance?.skills ?? []` into
the prompt composer. These are the exact revisions and names installed for the session, including
when the mutable catalog has since changed or disabled a skill.

The sidebar already reads the same SWR key, so normal SWR request deduplication and caching apply.
Failure to read provenance is non-blocking: the composer continues to accept and submit text with no
autocomplete list.

## Component Design

Add a reusable forwarded-ref `PromptSkillTextarea` under `packages/web/src/components/`. It owns the
native textarea and completion UI state while its parent owns the prompt value and submission side
effects.

The component interface should receive:

- The current textarea value.
- A forwarded textarea ref.
- A discriminated loading, error, or ready suggestion source.
- A value-change callback that uses the owning composer's normal draft update path.
- Existing keydown handling, or a callback invoked when autocomplete does not consume the event.
- Popup direction; both current prompt surfaces use `up`.
- Disabled state.

The component renders the native textarea rather than introducing a second search input or returning
a handler bag. It composes change, selection/click, keyup, keydown, composition, and blur handlers.
Recompute the active token from the latest value and `selectionStart`/`selectionEnd` instead of
deriving it only from the last typed character.

Render the suggestion list in the composer's existing relatively positioned input area. Constrain
its width and height to the composer, allow vertical scrolling, and use the existing background,
border, active, and muted-description design tokens. Do not reuse `Combobox` directly: it owns a
button and optional secondary search input, whereas prompt completion must retain textarea focus and
replace a caret-relative token.

The two existing prompt surfaces retain their current layout, attachment behavior, draft locking,
warming, typing indicator, and submission logic. Their textarea event handlers are routed through
the shared autocomplete component before falling back to current behavior.

## Keyboard And Accessibility Contract

The textarea remains the focused control and receives:

- `aria-autocomplete="list"`.
- `aria-expanded` reflecting whether suggestions are visible.
- `aria-controls` pointing to the listbox while it is available.
- `aria-activedescendant` pointing to the active option while one is selected.

The popup uses `role="listbox"`; each result uses `role="option"` and exposes its active state with
`aria-selected`.

When the list is open:

- ArrowDown and ArrowUp cycle through results and call `preventDefault()`.
- Unmodified Enter selects the active result instead of inserting a newline.
- Tab selects the active result instead of moving focus.
- Escape closes the menu and leaves the text unchanged.
- Cmd/Ctrl+Enter bypasses autocomplete and follows the current submit path.
- Shift/Alt-modified keys retain native behavior unless explicitly covered above.
- Composition events do not open, filter, navigate, or select autocomplete results.

Use `onPointerDown` with `preventDefault()` for pointer selection so the textarea does not blur
before replacement. Close the menu on a genuine blur after pointer selection has completed.

## File Changes

### Add

- `packages/web/src/lib/prompt-skill-completion.ts`
  - Parse the active token, filter skills, calculate the replacement range, and produce the updated
    value and caret offset.
- `packages/web/src/lib/prompt-skill-completion.test.ts`
  - Exhaustive pure tests for trigger boundaries, caret positions, matching, and replacement.
- `packages/web/src/components/prompt-skill-autocomplete.tsx`
  - Forwarded textarea integration, explicit interaction state, keyboard behavior, and focus
    management.
- `packages/web/src/components/prompt-skill-suggestion-panel.tsx`
  - Accessible loading, error, empty, and suggestion-list rendering.
- `packages/web/src/components/prompt-skill-autocomplete.test.tsx`
  - Interaction and accessibility tests independent of either page layout.

### Update

- `packages/web/src/hooks/use-managed-skills.ts`
  - Add the SWR-keyed resolution-preview hook and retain the existing imperative API helper.
- `packages/web/src/components/session-skill-selector.tsx`
  - Consume lifted preview state rather than issuing and reducing its own preview request.
- `packages/web/src/app/(app)/page.tsx`
  - Own resolution preview and provide its normalized suggestion source to the new-session textarea
    without changing session warming or submission.
- `packages/web/src/components/session-prompt-composer.tsx`
  - Accept pinned suggestions and render the reusable follow-up textarea.
- `packages/web/src/app/(app)/session/[id]/page.tsx`
  - Load pinned session skills, pass them to the composer, and route inserted values through the
    existing input-update behavior so errors, retry identity, and typing state remain correct.
- `packages/web/src/components/session-skill-selector.test.tsx`
  - Replace fetch-timing assertions with tests for supplied preview/loading state and displayed
    counts.
- `packages/web/src/app/(app)/page.test.tsx`
  - Cover the new-session integration and verify selected target/profile preview results govern the
    suggestion list.
- `packages/web/src/components/session-prompt-composer.test.tsx`
  - Cover pinned-skill integration while retaining current layout and disabled-state assertions.

No changes are required in `shared`, `control-plane`, `sandbox-runtime`, D1 migrations, session
creation requests, prompt HTTP routes, or WebSocket message schemas.

## Implementation Sequence

1. Add and test the pure token parser, prefix matcher, and replacement helper.
2. Add the shared autocomplete component with keyboard, pointer, focus, IME, and ARIA behavior.
3. Lift new-session resolution preview into the home page and connect its resolved skills to both
   the selector and autocomplete.
4. Load pinned skills on the session page and connect them to the follow-up composer.
5. Add page-level regression coverage for authoritative skill sources and unchanged submit behavior.
6. Run focused web tests, then the complete web test, lint, and typecheck commands.

## Test Matrix

### Pure completion behavior

- Opens for `/`, `$`, and partial prefixes at prompt start or after spaces/newlines.
- Does not open for URL paths, filesystem-like embedded slashes, mid-word dollars, invalid
  characters, ranged text selection, or nonmatching prefixes.
- Filters case-insensitively and preserves deterministic resolver order.
- Replaces a partial token at the beginning, middle, or end of a multiline prompt.
- Replaces the complete token when the caret is in its middle.
- Preserves surrounding text and punctuation and adds a trailing space only at prompt end.
- Returns the correct post-insertion caret offset.

### Component interaction

- Opens, filters, and closes based on textarea value and caret movement.
- Cycles active options with arrow keys and scrolls the active result into view.
- Selects with Enter, Tab, click, and touch-compatible pointer interaction.
- Escape dismisses without changing the value.
- Cmd/Ctrl+Enter still reaches the existing submit handler.
- Ordinary Enter still inserts a newline when no list is open.
- IME composition does not trigger or select a suggestion.
- Selection restores textarea focus and caret position.
- Listbox, option, expanded, controlled, and active-descendant attributes remain valid.
- Disabled/locked composers never open the list.

### Data-source integration

- New-session suggestions contain only skills returned by the current resolution preview.
- Target, All/None/profile, and stale-request changes update or clear suggestions consistently with
  the selector count.
- Follow-up suggestions contain only skills from the pinned session manifest.
- Empty, loading, and failed skill reads do not block typing or submission.
- Completed prompt text is submitted unchanged through the existing HTTP and WebSocket paths.

## Verification

Run:

```bash
npm test -w @open-inspect/web -- prompt-skill-completion prompt-skill-autocomplete session-skill-selector session-prompt-composer page
npm test -w @open-inspect/web
npm run lint -w @open-inspect/web
npm run typecheck -w @open-inspect/web
```

Manually verify desktop and mobile widths on both prompt surfaces:

- Popup direction and clipping.
- Keyboard and pointer selection.
- Long descriptions and the 20-skill maximum.
- Multiline prompts and internal-caret replacement.
- Composer behavior while warming, processing, disconnected, uploading, archived, or cancelled.

## Compatibility And Rollout

This is an additive web-only behavior. Existing clients, bots, automations, control-plane Workers,
and sandboxes require no coordinated deployment. Prompt payloads remain byte-for-byte equivalent to
manually typed references, and sessions without pinned skills simply expose no suggestions.

The existing `autoComplete="off"` attribute remains in place because it suppresses browser form
history/autofill; the custom list is controlled separately through ARIA attributes and React state.

## Out Of Scope

- Interpreting `/skill-name` or `$skill-name` as a command.
- Calling OpenCode's skill tool or changing OpenCode configuration.
- Adding skill IDs or references to prompt HTTP/WebSocket contracts.
- Changing the new-session skill selection when a suggestion is inserted.
- Adding an unavailable catalog skill to an existing session.
- Autocomplete for bundled, repository-local, `.claude`, or `.agents` skills not represented in the
  managed session manifest.
- Autocomplete in Slack, GitHub, Linear, terminal, or native OpenCode clients.
- Exact caret-coordinate popup positioning, fuzzy search, recency ranking, aliases, prompt history,
  or generalized slash commands.

# visual-verification

Use this skill when the goal is to verify UI changes inside the application and return visual
evidence in the Open-Inspect session.

`agent-browser` remains the low-level browser tool. This skill defines the workflow contract for
using it reliably.

## When To Use It

- Verify a UI change after editing code
- Capture before/after screenshots for comparison
- Confirm responsive layout differences at a chosen viewport
- Produce an uploaded screenshot artifact the user can review in-session

## Success Criteria

The task is not complete until all of these are true:

1. The changed UI is opened in the browser.
2. The capture mode is chosen explicitly: viewport or full-page.
3. The viewport is set explicitly or reported as a deliberate default.
4. A screenshot is uploaded with `upload-media` in the same prompt.
5. The returned `artifactId` is reported back to the user.
6. The response states what was verified and what dimensions/mode were used.

## Required Workflow

1. Open the target page with `agent-browser open`.
2. If viewport matters, set it explicitly with `agent-browser set viewport <width> <height>`.
3. Wait for the page to settle before capture.
4. Choose one of:
   - Viewport screenshot for above-the-fold or device-specific review
   - Full-page screenshot for full document review
5. Upload the screenshot immediately with matching metadata.
6. Report the result with the artifact ID and actual capture settings.

## Default Decision Rules

- Use a viewport screenshot when validating a specific visible state, modal, interaction, or
  desktop/mobile layout.
- Use a full-page screenshot when the user asks for the whole page or when vertical content is part
  of the verification.
- If the user names a device or screen size, set the viewport explicitly.
- If the user does not specify dimensions and layout matters, choose a reasonable viewport and
  report it.
- If the screenshot is intended to prove a fix, prefer stating exactly what was checked, not only
  that a screenshot was taken.

## Recommended Commands

Viewport capture:

```bash
agent-browser open "$URL" && \
agent-browser set viewport 1512 982 && \
agent-browser wait 2000 && \
agent-browser screenshot --json /tmp/verify.png && \
upload-media /tmp/verify.png \
  --caption "UI verification screenshot" \
  --source-url "$URL" \
  --viewport '{"width":1512,"height":982}'
```

Full-page capture:

```bash
agent-browser open "$URL" && \
agent-browser set viewport 1512 982 && \
agent-browser wait 2000 && \
agent-browser screenshot --full --json /tmp/verify-full.png && \
upload-media /tmp/verify-full.png \
  --caption "Full-page verification screenshot" \
  --source-url "$URL" \
  --viewport '{"width":1512,"height":982}' \
  --full-page
```

Annotated capture for review/debugging:

```bash
agent-browser open "$URL" && \
agent-browser wait 2000 && \
agent-browser screenshot --annotate --json /tmp/verify-annotated.png && \
upload-media /tmp/verify-annotated.png \
  --caption "Annotated UI verification screenshot" \
  --source-url "$URL" \
  --annotated
```

## Reporting Template

Include the following in the final response:

- What UI change or state was verified
- Whether the capture was viewport or full-page
- The viewport used
- The source URL
- The uploaded artifact ID
- Any limitation, such as auth gating, loading issues, or unverified states

Example:

```text
Verified the updated settings page header.
Capture mode: viewport
Viewport: 1512x982
Source: http://127.0.0.1:3000/settings
Uploaded artifact: abc123
```

## Guardrails

- Do not claim the screenshot was uploaded unless `upload-media` returned an artifact ID.
- Do not report viewport metadata you did not explicitly set or verify.
- Do not use `upload-media` in a later prompt; it is prompt-scoped.
- If the user asked for a full-page screenshot, do not use viewport-only capture.
- If the UI requires interaction before it matches the expected state, perform that interaction
  before capturing.

## Relationship To `agent-browser`

- Use `agent-browser` directly for open-ended browsing, debugging, auth flows, snapshots, and custom
  inspection.
- Use `visual-verification` when the deliverable is proof that a UI change works and the user should
  receive an uploaded screenshot artifact.

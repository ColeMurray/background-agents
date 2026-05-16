---
name: record-video
description: Record and upload a short browser interaction video artifact
---

# record-video

Use this skill when a UI verification depends on interaction over time: opening menus, clicking
through flows, dragging, typing, navigation, loading states, transitions, or animation.

## Key Facts

`start-browser-video` and `stop-browser-video` are **bash commands** installed on PATH. Run them
with your Bash tool. The recording is silent MP4, browser-only, and uploads when stopped.

## Required Workflow

1. Open the target page with `agent-browser open`.
2. Set the viewport explicitly when layout matters.
3. Start the recording with a caption and dimensions.
4. Perform the interaction being verified.
5. Stop the recording in the same prompt.
6. Report the returned `artifactId` and what interaction was verified.

## Command Pattern

```bash
agent-browser open "$URL" && \
agent-browser set viewport 1512 982 && \
start-browser-video \
  --caption "What this recording verifies" \
  --source-url "$URL" \
  --dimensions '{"width":1512,"height":982}' && \
agent-browser click "Button label" && \
agent-browser wait 1000 && \
stop-browser-video
```

## Guardrails

- Do not leave a recording active. Always run `stop-browser-video` after the interaction.
- Do not claim a video was uploaded unless `stop-browser-video` returned an artifact ID.
- Keep recordings short and focused on the behavior being verified.
- If the interaction fails, run `stop-browser-video` anyway so the recording can upload or report
  the capture failure.

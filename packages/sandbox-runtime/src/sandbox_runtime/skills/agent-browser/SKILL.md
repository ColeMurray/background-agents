# agent-browser

Use `agent-browser` from bash when you need visual verification in the sandbox.

## When To Use It

- Capture screenshots of a UI before or after a change
- Record short interaction videos that upload to the session
- Compare two states with a visual diff
- Inspect accessibility structure or page snapshots

## Core Commands

```bash
agent-browser screenshot --json /tmp/current.png
agent-browser screenshot --full --json /tmp/full-page.png
agent-browser screenshot --annotate --json /tmp/annotated.png
agent-browser diff screenshot --baseline /tmp/before.png -o /tmp/diff.png
```

Prefer `--json` when you need machine-readable output such as a saved path.

## Uploading Screenshots

Screenshots only appear in the Open-Inspect session after upload.

```bash
upload-media /tmp/current.png --caption "Dashboard after fix"
upload-media /tmp/full-page.png --full-page
upload-media /tmp/annotated.png --annotated
upload-media /tmp/current.png \
  --source-url "http://127.0.0.1:3000" \
  --viewport '{"width":1440,"height":900}'
```

## Working Pattern

1. Capture the current state with `agent-browser screenshot`.
2. Make or verify the UI change.
3. Upload the screenshot with `upload-media`.
4. When useful, upload before/after/diff images as separate artifacts.

## Recording Videos

Use `start-browser-video` before the interaction and `stop-browser-video` after it. The stop command
uploads the MP4 artifact.

```bash
agent-browser open "http://127.0.0.1:3000" && \
agent-browser set viewport 1440 900 && \
start-browser-video \
  --caption "Checkout flow recording" \
  --source-url "http://127.0.0.1:3000/checkout" \
  --dimensions '{"width":1440,"height":900}' && \
agent-browser click "Continue" && \
agent-browser wait 1000 && \
stop-browser-video
```

Do not leave a recording active after completing the interaction. Videos are limited to short,
silent MP4 recordings.

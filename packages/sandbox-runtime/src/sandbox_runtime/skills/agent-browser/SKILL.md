# agent-browser

Use `agent-browser` from bash when you need visual verification in the sandbox.

## When To Use It

- Capture screenshots of a UI before or after a change
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

`upload-media` is prompt-scoped. Run it while the current prompt is still executing.

## Working Pattern

1. Capture the current state with `agent-browser screenshot`.
2. Make or verify the UI change.
3. Upload the screenshot with `upload-media`.
4. When useful, upload before/after/diff images as separate artifacts.

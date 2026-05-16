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

Use `agent-browser record` for browser recordings. The verified upload path records WebM, converts
it to silent MP4 with `ffmpeg`, probes actual dimensions/duration with `ffprobe`, and uploads with
`upload-media`. The `record-browser-video` helper wraps that flow.

```bash
record-browser-video \
  --url "http://127.0.0.1:3000/checkout" \
  --caption "Checkout flow recording" \
  --output-basename /tmp/opencode/checkout-flow \
  --viewport 1440x900 \
  -- bash -lc 'agent-browser snapshot -i && agent-browser click "[data-testid=continue]" && agent-browser wait 1000'
```

When recording manually, always pair `agent-browser record start /tmp/opencode/demo.webm` with
`agent-browser record stop`, then convert:

```bash
ffmpeg -y -i /tmp/opencode/demo.webm -an -c:v libx264 -pix_fmt yuv420p -movflags +faststart /tmp/opencode/demo.mp4
```

Use stable selectors like `[data-testid=...]`, `[data-clear-completed]`, or `#todo-title` when
possible. Run `agent-browser snapshot -i` before recording if labels or selectors are uncertain. Do
not leave a recording active after completing the interaction.

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

Use `agent-browser record` for browser recordings. Record to an `.mp4` path so `agent-browser`
encodes a silent MP4, then probe actual dimensions/duration with `ffprobe` and upload with
`upload-media`.

```bash
agent-browser open "http://127.0.0.1:3000/checkout" && \
agent-browser set viewport 1440 900 && \
agent-browser snapshot -i && \
STARTED_AT_MS=$(date +%s%3N) && \
agent-browser record start /tmp/opencode/checkout-flow.mp4 && \
agent-browser click "[data-testid=continue]" && \
agent-browser wait 1000 && \
agent-browser record stop && \
ENDED_AT_MS=$(date +%s%3N)
```

When recording manually, always pair `agent-browser record start /tmp/opencode/demo.mp4` with
`agent-browser record stop`, then probe and upload the resulting MP4. Use the `record-video` skill
when you need the complete metadata and upload command pattern.

```bash
ffprobe -v error -print_format json -show_streams -show_format /tmp/opencode/demo.mp4
```

Use stable selectors like `[data-testid=...]`, `[data-clear-completed]`, or `#todo-title` when
possible. Run `agent-browser snapshot -i` before recording if labels or selectors are uncertain. Do
not leave a recording active after completing the interaction.

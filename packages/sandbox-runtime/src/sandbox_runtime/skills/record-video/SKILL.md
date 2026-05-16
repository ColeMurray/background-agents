---
name: record-video
description: Record and upload a short browser interaction video artifact
---

# record-video

Use this skill when a UI verification depends on interaction over time: opening menus, clicking
through flows, dragging, typing, navigation, loading states, transitions, or animation.

## Key Facts

Use `agent-browser record` as the primary recorder. Record directly to an `.mp4` path so
`agent-browser` encodes the recording as a silent MP4 that can be uploaded with `upload-media`.

## Required Workflow

1. Open the target page with `agent-browser open`.
2. Set the viewport explicitly when layout matters.
3. Use `agent-browser snapshot -i` to inspect accessible names/selectors before recording.
4. Start recording with `agent-browser record start <path>.mp4`.
5. Perform the interaction being verified.
6. Always run `agent-browser record stop`.
7. Use `ffprobe` to read actual encoded dimensions and duration before upload.
8. Report the returned `artifactId` and what interaction was verified.

## Command Pattern

```bash
agent-browser open "$URL" && \
agent-browser set viewport 1512 982 && \
agent-browser snapshot -i && \
STARTED_AT_MS=$(date +%s%3N) && \
agent-browser record start /tmp/opencode/demo.mp4 && \
agent-browser click "[data-testid=settings]" && \
agent-browser wait 1000 && \
agent-browser record stop && \
ENDED_AT_MS=$(date +%s%3N) && \
PROBE_JSON=$(ffprobe -v error -print_format json -show_streams -show_format /tmp/opencode/demo.mp4) && \
DURATION_MS=$(node -e 'const p=JSON.parse(process.argv[1]); const v=(p.streams||[]).find((s)=>s.codec_type==="video")||{}; const d=Number(v.duration ?? p.format?.duration); console.log(Math.max(1, Math.round(d * 1000)));' "$PROBE_JSON") && \
DIMENSIONS=$(node -e 'const p=JSON.parse(process.argv[1]); const v=(p.streams||[]).find((s)=>s.codec_type==="video")||{}; console.log(JSON.stringify({width:Number(v.width),height:Number(v.height)}));' "$PROBE_JSON") && \
upload-media /tmp/opencode/demo.mp4 \
  --artifact-type video \
  --caption "What this recording verifies" \
  --source-url "$URL" \
  --duration-ms "$DURATION_MS" \
  --recording-started-at "$STARTED_AT_MS" \
  --recording-ended-at "$ENDED_AT_MS" \
  --dimensions "$DIMENSIONS" \
  --truncated false \
  --has-audio false
```

## Guardrails

- Do not leave a recording active. Always run `agent-browser record stop` after starting.
- Do not claim a video was uploaded unless `upload-media` returned an artifact ID.
- Keep recordings short and focused on the behavior being verified.
- Prefer stable selectors such as `[data-testid=...]`, `[data-clear-completed]`, or `#todo-title`.
  Avoid fragile text selectors when labels contain apostrophes or dynamic text.
- Do not use requested viewport dimensions as video dimensions. Use `ffprobe` metadata from the
  encoded MP4.
- If a recording command fails, run `agent-browser record stop` to clear any active recording, then
  upload any available MP4.

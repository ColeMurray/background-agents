---
name: upload-screenshot
description: Upload an existing screenshot file to the Open-Inspect session
---

# upload-screenshot

Use this skill when you already have a screenshot file on disk and need to upload it to the
Open-Inspect session. The screenshot may have been captured by any source: Playwright MCP,
`agent-browser`, a manual file, or any other tool.

For the full browser-open + capture + upload workflow, use `visual-verification` instead.

## Key Fact

`upload-media` is a **bash command** installed on PATH. Run it with your Bash tool. It is not an MCP
tool or a tool binding.

## When To Use It

- Upload a screenshot that was already captured (e.g. via Playwright MCP)
- Upload an image file the user points you to
- The user says "upload the screenshot" or "upload this image"

## Required Workflow

1. Confirm the screenshot file exists on disk.
2. Run `upload-media` via Bash with the file path and metadata flags.
3. Report the returned `artifactId` to the user.

## Command

```bash
upload-media <file-path> \
  --caption "Description of screenshot" \
  --source-url "https://example.com" \
  [--full-page] \
  [--annotated] \
  [--viewport '{"width":1512,"height":982}']
```

All flags except the file path are optional. Include whichever metadata you know:

- `--caption` — what the screenshot shows
- `--source-url` — the URL that was captured
- `--full-page` — set if the screenshot is a full-page capture
- `--annotated` — set if the screenshot has annotations
- `--viewport` — JSON object with width and height of the viewport used

## Supported File Types

`.png`, `.jpg` / `.jpeg`, `.webp`

## Success Criteria

The task is not complete until:

1. `upload-media` returned a JSON response containing an `artifactId`.
2. The `artifactId` is reported to the user.
3. The response states what was uploaded and the source URL (if known).

## Example

```text
Uploaded screenshot of the homepage.
Source: https://example.com
Uploaded artifact: abc123def456
```

## Guardrails

- Do not claim the screenshot was uploaded unless `upload-media` returned an artifact ID.
- If the file does not exist or is not a supported type, report the error instead of retrying
  silently.
- If the user needs a full browser workflow (open page, set viewport, capture, upload), delegate to
  `visual-verification` instead.

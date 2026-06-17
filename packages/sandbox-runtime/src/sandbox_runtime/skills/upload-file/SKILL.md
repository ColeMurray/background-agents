---
name: upload-file
description:
  Upload generated files such as ZIP, PPTX, Markdown, PDF, DOCX, XLSX, CSV, JSON, or images as
  downloadable session artifacts
---

# upload-file

Use this skill when the user asks you to send back, attach, return, provide, or make downloadable a
generated file. This includes review packets, edited PPTX copies, ZIP archives, spreadsheets,
documents, PDFs, markdown reports, and source data exports.

`upload-file` is a **bash command** installed on PATH. Run it with your Bash tool. It is not an MCP
tool or a tool binding.

## Workflow

1. Create the output file under `/workspace` or `/tmp/opencode`.
2. Verify the file exists and is non-empty.
3. Run `upload-file` with the file path and an optional caption.
4. Report the returned `artifactId` and filename to the user.

## Usage

```bash
upload-file /workspace/review_packet_2028_synthetic.zip \
  --caption "Synthetic retirement module review packet"
```

Supported extensions:

- `.zip`
- `.pptx`
- `.docx`
- `.xlsx`
- `.pdf`
- `.md`
- `.txt`
- `.csv`
- `.json`
- `.png`
- `.jpg`
- `.jpeg`
- `.webp`

## Success Criteria

The upload succeeds only if `upload-file` returns JSON containing an `artifactId`.

Example response:

```json
{
  "artifactId": "abc123def456",
  "objectKey": "sessions/session-1/files/abc123def456/review_packet.zip",
  "filename": "review_packet.zip"
}
```

Do not claim a file was attached or uploaded unless the command returned an artifact ID.

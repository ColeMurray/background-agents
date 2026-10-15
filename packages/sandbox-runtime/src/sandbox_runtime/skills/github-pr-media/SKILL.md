---
name: github-pr-media
description:
  Attach local screenshots or videos to a GitHub pull request description when the user requests PR
  media or visual verification belongs in an authorized PR.
---

# GitHub PR media

Session artifacts and GitHub attachments are separate uploads. `upload-media` returns a session
artifact ID and storage key; neither can be embedded in a GitHub PR. Keep the original local files
to attach them to GitHub.

Create the PR with the `create-pull-request` tool so OpenInspect tracks it. Then append selected
images and videos to the returned PR URL using GitHub CLI:

```bash
gh pr edit https://github.com/OWNER/REPO/pull/123 \
  --attach '/tmp/after.png#Settings page after the fix' \
  --attach /tmp/demo.mp4
```

Omit `--body` and `--body-file` to preserve the existing description, including the session link,
and append media. Repeat `--attach` for each file. Quote paths with spaces; an image's optional alt
text follows `#`. Video attachments have no alt text and render as players.

Use the explicit PR URL returned by the tool, especially in multi-repository sessions. Attach only
media relevant to that PR. Upload to the session as well when session artifacts were requested.

## Availability and verification

- Check `gh pr edit --help` for `--attach` support. GitHub introduced it in CLI v2.99.0; older
  sandbox images may need rebuilding. GitHub Enterprise Server is unsupported.
- Uploads require repository write access and a supported user token. The default brokered GitHub
  App installation token cannot upload attachments. An existing `GH_TOKEN` or `GITHUB_TOKEN` is
  preserved by OpenInspect's wrapper; GitHub decides whether the particular user token can upload.
  Do not print credentials or change authentication automatically. If uploads are unavailable,
  report the limitation and retain the session artifact links as a fallback.
- A nonzero exit may still mean some files were attached. Read the PR body before retrying and retry
  only missing files, to avoid duplicate uploads. Do not rerun PR creation to attach media.
- Verify the description contains GitHub attachment URLs, using
  `gh pr view https://github.com/OWNER/REPO/pull/123 --json body --jq .body`. Report the full PR URL
  and any missing attachments. A session artifact ID alone does not prove a GitHub upload.

See
[GitHub's media announcement](https://github.blog/changelog/2026-09-01-github-cli-media-in-issues-pull-requests-and-comments/)
and the installed CLI's help for current limits and token support.

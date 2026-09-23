# OpenInspect documentation site

User-facing documentation for [docs.backgroundagents.dev](https://docs.backgroundagents.dev), built
with Next.js and Fumadocs.

## Local development

From the repository root:

```bash
npm install
npm run dev -w @open-inspect/docs
```

The site is available at `http://localhost:3000`. Run the package checks with:

```bash
npm test -w @open-inspect/docs
npm run typecheck -w @open-inspect/docs
npm run build -w @open-inspect/docs
```

## Content model

Public pages live in `content/docs` as MDX, one folder per sidebar section (`getting-started`,
`prompting`, `sessions`, `configure`, `models`, `automations`, `integrations`, `administration`,
`reference`). Each folder's `meta.json` fixes the page order. Every page must declare:

- `title` and `description` for navigation and search results;
- `audience`, which must be one of the public audience categories;
- `owner`, the team responsible for technical accuracy;
- `status: published`;
- `lastReviewed` as a real calendar date in `YYYY-MM-DD` form; and
- `relatedCode`, at least one repository-relative, git-tracked source path used to verify the page.

The schema (`src/lib/content-policy.ts`) rejects an `internal` audience, unpublished status,
impossible dates, and source paths that leave the repository. Internal operational notes belong
outside this package.

Diagrams are Mermaid code fences (` ```mermaid `), rendered on the client by
`src/components/mermaid.tsx` with the site palette in both color schemes. Prefer top-to-bottom
layouts; the content column is about 665px wide. Screenshots live under `public/images/<section>/`
as WebP captured at 1440x900 with a 2x device scale, and are placed with ordinary Markdown images
whose title becomes the caption: `![alt](/images/section/name.webp "Caption")`. Capture them from a
demo workspace or rewrite every session title, repository, user name, avatar, email, and secret name
before capture; nothing from a real workspace may appear in a published screenshot.

The content tests load the same Fumadocs source the site renders (`src/lib/source.test-support.ts`
starts a Vite module runner for it) and check that every page is reachable from the navigation,
every internal link resolves, every `relatedCode` path is tracked, and `llms.txt` links the Markdown
representation of every page.

## Editorial workflow

1. Verify behavior against the current product source (`docs/*.md`, `packages/*`) and tests.
2. Write task-oriented copy for the reader: what to do, the limits that apply, and where a person
   approves. Use the product's own labels (for example Settings › Models).
3. Prefer tables for enumerations, numbered steps for procedures, fenced `text` blocks for literal
   prompts, and a Troubleshooting section wherever the source documents failure modes.
4. Add a diagram where a flow or state machine is described in prose, and a screenshot where the
   page names a screen the reader has to find.
5. Add or update `relatedCode` and `lastReviewed`.
6. Run the package checks above.
7. Use the page's **Give feedback** or **Edit on GitHub** links for follow-up corrections.

## Production deployment

The `Deploy Docs` GitHub Actions workflow deploys the package to a dedicated Vercel project after
the `CI (TypeScript)` workflow succeeds for a commit on `main` that touched the docs site. The
repository must define:

- `VERCEL_API_TOKEN`
- `VERCEL_TEAM_ID`
- `VERCEL_DOCS_PROJECT_ID`

Configure the Vercel project with `packages/docs` as its root directory and attach
`docs.backgroundagents.dev` as its production domain. Do not merge the marketing-site links until
the hostname resolves and serves the production docs deployment.

After deployment, verify:

```bash
curl --fail --location https://docs.backgroundagents.dev/
curl --fail https://docs.backgroundagents.dev/robots.txt
curl --fail https://docs.backgroundagents.dev/sitemap.xml
curl --fail https://docs.backgroundagents.dev/llms.txt
```

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

Public pages live in `content/docs` as MDX. Every page must declare:

- `title` and `description` for navigation and search results;
- `audience`, which must be one of the public audience categories;
- `owner`, the team responsible for technical accuracy;
- `status: published`;
- `lastReviewed` as an ISO date; and
- `relatedCode`, the source files used to verify product behavior.

The schema rejects an `internal` audience and unpublished status. Internal operational notes belong
outside this package.

## Editorial workflow

1. Verify behavior against the current product source and tests.
2. Write task-oriented copy for the reader, including limits and human approval points.
3. Add or update `relatedCode` and `lastReviewed`.
4. Run the package checks above.
5. Use the page's **Give feedback** or **Edit this page** links for follow-up corrections.

## Production deployment

The `Deploy Docs` GitHub Actions workflow deploys the package to a dedicated Vercel project. The
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

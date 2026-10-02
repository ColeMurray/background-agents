import { expect, it } from "vitest";
import { inferProjectSourceReference } from "./project-source-reference";
it.each([
  [
    "https://linear.app/acme/project/billing",
    "linear_project",
    "https://linear.app/acme/project/billing",
  ],
  ["https://acme.slack.com/archives/C123", "slack_channel", "https://acme.slack.com/archives/C123"],
  ["https://github.com/acme/app/blob/main/docs/plan.md", "repo_doc", "acme/app:docs/plan.md"],
  [
    "https://gitlab.com/group/subgroup/app/-/blob/main/docs/plan.md",
    "repo_doc",
    "group/subgroup/app:docs/plan.md",
  ],
  ["https://example.com/a", "url", "https://example.com/a"],
])("infers the reference kind for %s", (ref, sourceType, externalIdOrUrl) => {
  expect(inferProjectSourceReference(ref)).toEqual({ sourceType, externalIdOrUrl });
});

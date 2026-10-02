import { expect, it } from "vitest";
import { inferProjectSourceReference } from "./project-source-reference";
it.each([
  [
    "https://linear.app/acme/project/billing",
    "linear_project",
    "https://linear.app/acme/project/billing",
  ],
  ["https://acme.slack.com/archives/C123", "slack_channel", "https://acme.slack.com/archives/C123"],
  [
    "https://github.com/acme/app/blob/main/docs/plan.md",
    "url",
    "https://github.com/acme/app/blob/main/docs/plan.md",
  ],
  [
    "https://gitlab.com/group/subgroup/app/-/blob/main/docs/plan.md",
    "url",
    "https://gitlab.com/group/subgroup/app/-/blob/main/docs/plan.md",
  ],
  ["https://example.com/a", "url", "https://example.com/a"],
])("infers the reference kind for %s", (ref, sourceType, externalIdOrUrl) => {
  expect(inferProjectSourceReference(ref)).toEqual({ sourceType, externalIdOrUrl });
});

it.each([
  "https://github.com/acme/app/blob/feature/cutover/docs/plan.md",
  "https://github.com/acme/app/blob/feature%2Fcutover/docs/plan.md",
  "https://gitlab.com/group/subgroup/app/-/blob/feature/cutover/docs/plan.md",
])("preserves an ambiguous named ref: %s", (ref) => {
  expect(inferProjectSourceReference(ref)).toEqual({ sourceType: "url", externalIdOrUrl: ref });
});

it.each([
  ["https://github.com/acme/app/blob/", "acme/app"],
  ["https://gitlab.com/group/subgroup/app/-/blob/", "group/subgroup/app"],
])("recognizes an unambiguous commit boundary in %s", (prefix, repository) => {
  expect(inferProjectSourceReference(`${prefix}${"a".repeat(40)}/docs/plan.md`)).toEqual({
    sourceType: "repo_doc",
    externalIdOrUrl: `${repository}:docs/plan.md`,
  });
});

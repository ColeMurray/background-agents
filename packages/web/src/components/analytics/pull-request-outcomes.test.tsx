// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, expect, it } from "vitest";
import { AnalyticsPullRequestOutcomes } from "./pull-request-outcomes";

expect.extend(matchers);
afterEach(cleanup);

it("labels every outcome and sizes the bar by count", () => {
  const { container } = render(
    <AnalyticsPullRequestOutcomes
      funnel={{ created: 10, open: 2, draft: 0, merged: 6, closed: 2 }}
    />
  );
  expect(screen.getByText("75% of resolved PRs merged")).toBeInTheDocument();
  for (const label of ["Merged", "Open", "Draft", "Closed unmerged"]) {
    expect(screen.getByText(label)).toBeInTheDocument();
  }
  const segments = container.querySelectorAll("[aria-hidden='true'].flex > span");
  // Draft has no PRs, so it gets no segment.
  expect(segments).toHaveLength(3);
  expect(segments[0]).toHaveStyle({ flexGrow: "6" });
});

it("shows an empty message when nothing was opened", () => {
  render(
    <AnalyticsPullRequestOutcomes
      funnel={{ created: 0, open: 0, draft: 0, merged: 0, closed: 0 }}
    />
  );
  expect(screen.getByText("No pull requests found for this range.")).toBeInTheDocument();
});

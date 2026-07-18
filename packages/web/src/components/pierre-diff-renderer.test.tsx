// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { CSSProperties } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@pierre/diffs/react", () => ({
  PatchDiff: ({
    style,
    metrics,
  }: {
    style: CSSProperties & Record<`--${string}`, string>;
    metrics: { lineHeight: number };
  }) => (
    <div
      data-testid="patch-diff"
      data-font-size={style["--diffs-font-size"]}
      data-line-height={style["--diffs-line-height"]}
      data-metric-line-height={metrics.lineHeight}
    />
  ),
}));

import PierreDiffRenderer from "./pierre-diff-renderer";

afterEach(cleanup);

describe("PierreDiffRenderer", () => {
  it("uses compact, internally consistent code metrics", () => {
    render(
      <PierreDiffRenderer
        patch="@@ -1 +1 @@\n-old\n+new"
        diffStyle="unified"
        wrap
        themeType="dark"
      />
    );

    expect(screen.getByTestId("patch-diff")).toHaveAttribute("data-font-size", "12px");
    expect(screen.getByTestId("patch-diff")).toHaveAttribute("data-line-height", "18px");
    expect(screen.getByTestId("patch-diff")).toHaveAttribute("data-metric-line-height", "18");
  });
});

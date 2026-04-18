// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { AnalyticsUserTable } from "./user-table";

expect.extend(matchers);

describe("AnalyticsUserTable", () => {
  it("uses the real completion rate for the progress bar width", () => {
    const { container } = render(
      <AnalyticsUserTable
        entries={[
          {
            key: "zoe",
            sessions: 20,
            completed: 1,
            failed: 8,
            cancelled: 1,
            cost: 3.5,
            prs: 1,
            messageCount: 12,
            avgDuration: 90_000,
            lastActive: Date.UTC(2026, 3, 12),
          },
        ]}
        loading={false}
        sortKey="completionRate"
        sortDirection="desc"
        onSort={() => {}}
      />
    );

    expect(screen.getByText("10%")).toBeInTheDocument();
    const progressBar = container.querySelector(".bg-accent");
    expect(progressBar).toHaveStyle({ width: "10%" });
  });
});

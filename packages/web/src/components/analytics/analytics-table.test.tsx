// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, describe, expect, it } from "vitest";
import { AnalyticsTable, type AnalyticsTableColumn } from "./analytics-table";

expect.extend(matchers);
afterEach(cleanup);

interface Row {
  name: string;
  sessions: number;
}

const rows: Row[] = [
  { name: "beta", sessions: 2 },
  { name: "alpha", sessions: 9 },
  { name: "gamma", sessions: 5 },
];

const columns: AnalyticsTableColumn<Row>[] = [
  { id: "name", header: "Name", sortValue: (row) => row.name, cell: (row) => row.name },
  {
    id: "sessions",
    header: "Sessions",
    align: "right",
    sortValue: (row) => row.sessions,
    barValue: (row) => row.sessions,
    cell: (row) => String(row.sessions),
  },
];

function names() {
  return screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[0].textContent);
}

describe("AnalyticsTable", () => {
  it("applies the initial sort and toggles direction from the header", async () => {
    const user = userEvent.setup();
    render(
      <AnalyticsTable
        label="Things"
        rows={rows}
        columns={columns}
        rowKey={(row) => row.name}
        initialSort={{ columnId: "sessions", direction: "desc" }}
      />
    );

    expect(names()).toEqual(["alpha", "gamma", "beta"]);
    expect(screen.getByRole("columnheader", { name: "Sessions" })).toHaveAttribute(
      "aria-sort",
      "descending"
    );

    await user.click(screen.getByRole("button", { name: "Sessions" }));
    expect(names()).toEqual(["beta", "gamma", "alpha"]);
    expect(screen.getByRole("columnheader", { name: "Sessions" })).toHaveAttribute(
      "aria-sort",
      "ascending"
    );
  });

  it("sorts text columns A to Z first and measures largest first", async () => {
    const user = userEvent.setup();
    render(
      <AnalyticsTable label="Things" rows={rows} columns={columns} rowKey={(row) => row.name} />
    );

    expect(names()).toEqual(["beta", "alpha", "gamma"]);
    await user.click(screen.getByRole("button", { name: "Name" }));
    expect(names()).toEqual(["alpha", "beta", "gamma"]);
    await user.click(screen.getByRole("button", { name: "Sessions" }));
    expect(names()).toEqual(["alpha", "gamma", "beta"]);
    expect(screen.getByRole("columnheader", { name: "Name" })).not.toHaveAttribute("aria-sort");
  });

  it("limits rows until expanded", async () => {
    const user = userEvent.setup();
    render(
      <AnalyticsTable
        label="Things"
        rows={rows}
        columns={columns}
        rowKey={(row) => row.name}
        limit={2}
      />
    );

    expect(names()).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Show all 3" }));
    expect(names()).toHaveLength(3);
    await user.click(screen.getByRole("button", { name: "Show fewer" }));
    expect(names()).toHaveLength(2);
  });

  it("scales magnitude bars to the column maximum", () => {
    const { container } = render(
      <AnalyticsTable label="Things" rows={rows} columns={columns} rowKey={(row) => row.name} />
    );
    const bars = container.querySelectorAll("tbody .bg-accent");
    expect(bars[1]).toHaveStyle({ width: "100%" });
    expect(bars[0]).toHaveStyle({ width: `${(2 / 9) * 100}%` });
  });

  it("shows the empty message instead of a table", () => {
    render(
      <AnalyticsTable
        label="Things"
        rows={[]}
        columns={columns}
        rowKey={(row) => row.name}
        emptyMessage="Nothing here."
      />
    );
    expect(screen.getByText("Nothing here.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});

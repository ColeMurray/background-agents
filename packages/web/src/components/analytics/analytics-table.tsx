"use client";

import { useMemo, useState, type ReactNode } from "react";
import { ChevronDownIcon, ChevronUpIcon } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { AnalyticsEmptyNote } from "./analytics-panel";

type SortDirection = "asc" | "desc";

export interface AnalyticsTableColumn<Row> {
  id: string;
  header: string;
  align?: "left" | "right";
  cell: (row: Row) => ReactNode;
  /** Makes the column sortable by this value. */
  sortValue?: (row: Row) => number | string;
  /** Draws a magnitude bar beside the value, scaled to the column's largest value. */
  barValue?: (row: Row) => number;
  /** Hides the column below a breakpoint, for secondary measures. */
  hideBelow?: "sm" | "md" | "lg" | "xl" | "2xl";
}

const HIDE_BELOW = {
  sm: "hidden sm:table-cell",
  md: "hidden md:table-cell",
  lg: "hidden lg:table-cell",
  xl: "hidden xl:table-cell",
  "2xl": "hidden 2xl:table-cell",
} as const;

/** Sortable breakdown table; every analytics table shares this layout. */
export function AnalyticsTable<Row>({
  label,
  rows,
  columns,
  rowKey,
  initialSort,
  limit,
  emptyMessage = "Nothing in this range.",
}: {
  label: string;
  rows: readonly Row[];
  columns: AnalyticsTableColumn<Row>[];
  rowKey: (row: Row) => string;
  initialSort?: { columnId: string; direction: SortDirection };
  limit?: number;
  emptyMessage?: string;
}) {
  const [sort, setSort] = useState(initialSort);
  const [expanded, setExpanded] = useState(false);

  const sorted = useMemo(() => {
    const sortValue = columns.find((column) => column.id === sort?.columnId)?.sortValue;
    if (!sort || !sortValue) return rows;
    const sign = sort.direction === "asc" ? 1 : -1;
    return [...rows].sort((left, right) => {
      const a = sortValue(left);
      const b = sortValue(right);
      const compared =
        typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));
      return compared * sign || rowKey(left).localeCompare(rowKey(right));
    });
  }, [columns, rowKey, rows, sort]);

  const barMaxima = useMemo(
    () =>
      new Map(
        columns
          .filter((column) => column.barValue)
          .map((column) => [column.id, Math.max(0, ...rows.map((row) => column.barValue!(row)))])
      ),
    [columns, rows]
  );

  if (!rows.length) return <AnalyticsEmptyNote>{emptyMessage}</AnalyticsEmptyNote>;
  const visible = limit && !expanded ? sorted.slice(0, limit) : sorted;

  function toggleSort(column: AnalyticsTableColumn<Row>) {
    setSort((current) => {
      if (current?.columnId === column.id) {
        return { columnId: column.id, direction: current.direction === "desc" ? "asc" : "desc" };
      }
      // Names read best A→Z; measures read best largest first.
      const textual = typeof column.sortValue?.(rows[0]) === "string";
      return { columnId: column.id, direction: textual ? "asc" : "desc" };
    });
  }

  return (
    <div>
      <div className="-mx-4 overflow-x-auto">
        <table aria-label={label} className="min-w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border-muted">
              {columns.map((column, index) => {
                const active = sort?.columnId === column.id;
                return (
                  <th
                    key={column.id}
                    scope="col"
                    aria-sort={
                      active ? (sort.direction === "asc" ? "ascending" : "descending") : undefined
                    }
                    className={cn(
                      "whitespace-nowrap py-2 text-xs font-medium text-muted-foreground",
                      cellPadding(index, columns.length),
                      column.align === "right" ? "text-right" : "text-left",
                      column.hideBelow && HIDE_BELOW[column.hideBelow]
                    )}
                  >
                    {column.sortValue ? (
                      <button
                        type="button"
                        onClick={() => toggleSort(column)}
                        className={cn(
                          "inline-flex items-center gap-1 rounded hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring",
                          active && "text-foreground"
                        )}
                      >
                        {column.header}
                        {active ? (
                          sort.direction === "asc" ? (
                            <ChevronUpIcon className="h-3 w-3" />
                          ) : (
                            <ChevronDownIcon className="h-3 w-3" />
                          )
                        ) : null}
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <tr
                key={rowKey(row)}
                className="border-b border-border-muted last:border-b-0 hover:bg-muted"
              >
                {columns.map((column, index) => (
                  <td
                    key={column.id}
                    className={cn(
                      "whitespace-nowrap py-2 align-middle text-foreground",
                      cellPadding(index, columns.length),
                      column.align === "right" && "text-right tabular-nums",
                      column.hideBelow && HIDE_BELOW[column.hideBelow]
                    )}
                  >
                    {column.barValue ? (
                      <span className="flex items-center justify-end gap-2.5">
                        <MagnitudeBar
                          value={column.barValue(row)}
                          max={barMaxima.get(column.id) ?? 0}
                        />
                        <span className="min-w-[3.25rem]">{column.cell(row)}</span>
                      </span>
                    ) : (
                      column.cell(row)
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {limit && rows.length > limit ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="mt-2 rounded px-2 py-1 text-xs font-medium text-accent hover:bg-accent-muted"
        >
          {expanded ? "Show fewer" : `Show all ${rows.length}`}
        </button>
      ) : null}
    </div>
  );
}

function cellPadding(index: number, count: number): string {
  if (index === 0) return "pl-4 pr-3";
  return index === count - 1 ? "pl-3 pr-4" : "px-3";
}

function MagnitudeBar({ value, max }: { value: number; max: number }) {
  return (
    <span aria-hidden="true" className="h-1.5 w-14 shrink-0 rounded-full bg-muted">
      <span
        className="block h-full rounded-full bg-accent"
        style={{ width: `${max > 0 ? (value / max) * 100 : 0}%` }}
      />
    </span>
  );
}

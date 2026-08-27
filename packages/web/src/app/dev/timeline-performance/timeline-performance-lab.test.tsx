// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TimelineRuntimeMetrics } from "@/lib/timeline-diagnostics";
import { TimelinePerformanceLab } from "./timeline-performance-lab";

const mocks = vi.hoisted(() => ({
  generateFixture: vi.fn((eventCount: number) => new Array(eventCount)),
  runtimeMetrics: null as TimelineRuntimeMetrics | null,
}));

vi.mock("@/lib/timeline-performance-fixture", () => ({
  LARGE_SESSION_EVENT_COUNT: 100_000,
  generateTimelinePerformanceFixture: mocks.generateFixture,
  summarizeTimelinePerformanceFixture: (events: unknown[]) => ({
    eventCount: events.length,
    byType: {},
    approximateJsonBytes: events.length,
  }),
}));

vi.mock("@/components/session-timeline", () => ({
  SessionTimeline: () => <div className="overflow-y-auto" />,
}));

vi.mock("@/components/timeline-debug-panel", () => ({
  TimelineDebugPanel: ({
    runtimeMetricsRef,
  }: {
    runtimeMetricsRef: { current: TimelineRuntimeMetrics };
  }) => {
    mocks.runtimeMetrics = runtimeMetricsRef.current;
    return <output data-testid="long-task-count">{runtimeMetricsRef.current.longTaskCount}</output>;
  },
}));

beforeEach(() => {
  mocks.generateFixture.mockClear();
  mocks.runtimeMetrics = null;
});

afterEach(cleanup);

describe("TimelinePerformanceLab", () => {
  it("does not generate the fixture during server rendering", () => {
    renderToString(<TimelinePerformanceLab />);

    expect(mocks.generateFixture).not.toHaveBeenCalled();
  });

  it("resets cumulative metrics when the dataset changes", async () => {
    const view = render(<TimelinePerformanceLab />);
    const select = await view.findByRole("combobox", { name: "Full session events" });
    mocks.runtimeMetrics!.longTaskCount = 12;

    fireEvent.change(select, { target: { value: "5000" } });

    expect(view.getByTestId("long-task-count")).toHaveTextContent("0");
    expect(view.getByText("500")).toBeInTheDocument();
  });
});

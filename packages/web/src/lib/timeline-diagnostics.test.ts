// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  createTimelineDiagnosticsSnapshot,
  createTimelineRuntimeMetrics,
  formatMetricBytes,
} from "./timeline-diagnostics";

describe("createTimelineDiagnosticsSnapshot", () => {
  it("uses incremental visibility data without reading child layout", () => {
    const container = document.createElement("div");
    Object.defineProperties(container, {
      scrollTop: { value: 300, configurable: true },
      scrollHeight: { value: 1_000, configurable: true },
      clientHeight: { value: 200, configurable: true },
    });

    const snapshot = createTimelineDiagnosticsSnapshot({
      container,
      eventCount: 100,
      renderedChildCount: 40,
      domNodeCount: null,
      visibleChildren: [
        { index: 12, top: 80 },
        { index: 10, top: -20 },
        { index: 11, top: 20 },
      ],
      runtime: { ...createTimelineRuntimeMetrics(), renderDurationMs: 12.5 },
    });

    expect(snapshot.visibleRange).toEqual([10, 12]);
    expect(snapshot.anchorIndex).toBe(10);
    expect(snapshot.anchorOffsetPx).toBe(-20);
    expect(snapshot.scrollTop).toBe(300);
    expect(snapshot.renderDurationMs).toBe(12.5);
  });
});

describe("formatMetricBytes", () => {
  it("handles supported and unsupported heap measurements", () => {
    expect(formatMetricBytes(null)).toBe("unsupported");
    expect(formatMetricBytes(512)).toBe("512 B");
    expect(formatMetricBytes(5 * 1024)).toBe("5.0 KiB");
    expect(formatMetricBytes(5 * 1024 * 1024)).toBe("5.0 MiB");
  });
});

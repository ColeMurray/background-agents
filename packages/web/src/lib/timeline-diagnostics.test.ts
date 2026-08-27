// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  collectTimelineDiagnostics,
  createTimelineRuntimeMetrics,
  formatMetricBytes,
  publishTimelineHistoryMetric,
  TIMELINE_HISTORY_METRIC_EVENT,
  timelineDiagnosticsRequested,
} from "./timeline-diagnostics";

describe("collectTimelineDiagnostics", () => {
  it("reports visible rows and the topmost visible anchor", () => {
    const container = document.createElement("div");
    const content = document.createElement("div");
    container.append(content);
    Object.defineProperties(container, {
      scrollTop: { value: 300, configurable: true },
      scrollHeight: { value: 1_000, configurable: true },
      clientHeight: { value: 200, configurable: true },
    });
    container.getBoundingClientRect = () => ({ top: 100, bottom: 300, height: 200 }) as DOMRect;

    for (const [id, top, bottom] of [
      ["above", 20, 80],
      ["anchor", 80, 140],
      ["visible", 140, 220],
      ["below", 320, 380],
    ] as const) {
      const row = document.createElement("div");
      row.dataset.timelineRow = id;
      row.getBoundingClientRect = () => ({ top, bottom, height: bottom - top }) as DOMRect;
      content.append(row);
    }

    const snapshot = collectTimelineDiagnostics({
      container,
      content,
      eventCount: 100,
      itemCount: 4,
      derivationDurationMs: 12.5,
      runtime: { ...createTimelineRuntimeMetrics(), historyRequestCount: 2 },
    });

    expect(snapshot.visibleRange).toEqual([1, 2]);
    expect(snapshot.anchorId).toBe("anchor");
    expect(snapshot.anchorOffsetPx).toBe(-20);
    expect(snapshot.scrollTop).toBe(300);
    expect(snapshot.historyRequestCount).toBe(2);
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

describe("timeline history diagnostics", () => {
  it("publishes metrics only after diagnostics are requested by the session URL", () => {
    window.history.replaceState({}, "", "/session/test?timelineDebug=1");
    expect(timelineDiagnosticsRequested()).toBe(true);
    const listener = vi.fn();
    window.addEventListener(TIMELINE_HISTORY_METRIC_EVENT, listener);

    publishTimelineHistoryMetric({ latencyMs: 25, payloadBytes: 4_096 });

    expect(listener).toHaveBeenCalledOnce();
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({
      latencyMs: 25,
      payloadBytes: 4_096,
    });
    window.removeEventListener(TIMELINE_HISTORY_METRIC_EVENT, listener);
    window.history.replaceState({}, "", "/");
  });
});

"use client";

import type { RefObject } from "react";
import { useEffect, useLayoutEffect, useState } from "react";
import {
  collectTimelineDiagnostics,
  formatMetricBytes,
  TIMELINE_HISTORY_METRIC_EVENT,
  type TimelineHistoryMetric,
  type TimelineDiagnosticsSnapshot,
  type TimelineRuntimeMetrics,
} from "@/lib/timeline-diagnostics";

interface LayoutShiftEntry extends PerformanceEntry {
  hadRecentInput: boolean;
  value: number;
}

export function TimelineDebugPanel({
  containerRef,
  contentRef,
  eventCount,
  itemCount,
  derivationDurationMs,
  runtimeMetricsRef,
  loadedRangeStart,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  eventCount: number;
  itemCount: number;
  derivationDurationMs: number;
  runtimeMetricsRef: RefObject<TimelineRuntimeMetrics>;
  loadedRangeStart?: number;
}) {
  const [snapshot, setSnapshot] = useState<TimelineDiagnosticsSnapshot | null>(null);

  useLayoutEffect(() => {
    setSnapshot(
      collectTimelineDiagnostics({
        container: containerRef.current,
        content: contentRef.current,
        eventCount,
        itemCount,
        derivationDurationMs,
        runtime: runtimeMetricsRef.current,
      })
    );
  }, [containerRef, contentRef, derivationDurationMs, eventCount, itemCount, runtimeMetricsRef]);

  useEffect(() => {
    const recordHistoryPage = (event: Event) => {
      const metric = (event as CustomEvent<TimelineHistoryMetric>).detail;
      runtimeMetricsRef.current.historyRequestCount += 1;
      runtimeMetricsRef.current.lastHistoryLatencyMs = metric.latencyMs;
      runtimeMetricsRef.current.lastHistoryPayloadBytes = metric.payloadBytes;
      runtimeMetricsRef.current.totalHistoryPayloadBytes += metric.payloadBytes;
    };
    window.addEventListener(TIMELINE_HISTORY_METRIC_EVENT, recordHistoryPage);
    return () => window.removeEventListener(TIMELINE_HISTORY_METRIC_EVENT, recordHistoryPage);
  }, [runtimeMetricsRef]);

  useEffect(() => {
    const collect = () =>
      setSnapshot(
        collectTimelineDiagnostics({
          container: containerRef.current,
          content: contentRef.current,
          eventCount,
          itemCount,
          derivationDurationMs,
          runtime: runtimeMetricsRef.current,
        })
      );
    const interval = window.setInterval(collect, 500);
    const container = containerRef.current;
    container?.addEventListener("scroll", collect, { passive: true });
    return () => {
      window.clearInterval(interval);
      container?.removeEventListener("scroll", collect);
    };
  }, [containerRef, contentRef, derivationDurationMs, eventCount, itemCount, runtimeMetricsRef]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    let previousHeight = content.getBoundingClientRect().height;
    const observer = new ResizeObserver(() => {
      const height = content.getBoundingClientRect().height;
      const delta = height - previousHeight;
      previousHeight = height;
      if (delta === 0) return;
      runtimeMetricsRef.current.resizeCount += 1;
      runtimeMetricsRef.current.lastResizeDeltaPx = delta;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [contentRef, runtimeMetricsRef]);

  useEffect(() => {
    if (typeof PerformanceObserver === "undefined") return;
    const observers: PerformanceObserver[] = [];
    const observe = (type: string, callback: (entries: PerformanceEntry[]) => void) => {
      if (!PerformanceObserver.supportedEntryTypes?.includes(type)) return;
      const observer = new PerformanceObserver((list) => callback(list.getEntries()));
      observer.observe({ type, buffered: true });
      observers.push(observer);
    };
    observe("layout-shift", (entries) => {
      for (const entry of entries as LayoutShiftEntry[]) {
        if (!entry.hadRecentInput) runtimeMetricsRef.current.layoutShiftScore += entry.value;
      }
    });
    observe("longtask", (entries) => {
      runtimeMetricsRef.current.longTaskCount += entries.length;
      runtimeMetricsRef.current.longTaskDurationMs += entries.reduce(
        (duration, entry) => duration + entry.duration,
        0
      );
    });
    return () => observers.forEach((observer) => observer.disconnect());
  }, [runtimeMetricsRef]);

  if (!snapshot) return null;
  const visibleRange = snapshot.visibleRange
    ? `${snapshot.visibleRange[0]}-${snapshot.visibleRange[1]}`
    : "none";

  return (
    <aside
      data-testid="timeline-debug-panel"
      className="fixed bottom-3 right-3 z-50 w-80 max-h-[calc(100vh-1.5rem)] overflow-auto rounded-md border border-border bg-background/95 p-3 font-mono text-[11px] leading-5 text-foreground shadow-xl backdrop-blur"
    >
      <div className="mb-2 font-semibold">Timeline diagnostics</div>
      <Metric
        label="Loaded range"
        value={
          loadedRangeStart !== undefined && snapshot.eventCount
            ? `${loadedRangeStart}-${loadedRangeStart + snapshot.eventCount - 1}`
            : `${snapshot.eventCount} contiguous events`
        }
      />
      <Metric label="Events / items" value={`${snapshot.eventCount} / ${snapshot.itemCount}`} />
      <Metric label="Rows / DOM nodes" value={`${snapshot.rowCount} / ${snapshot.domNodeCount}`} />
      <Metric label="Visible rows" value={visibleRange} />
      <Metric label="Anchor" value={snapshot.anchorId ?? "none"} />
      <Metric
        label="Anchor offset"
        value={
          snapshot.anchorOffsetPx === null ? "n/a" : `${snapshot.anchorOffsetPx.toFixed(1)} px`
        }
      />
      <Metric label="Derivation" value={`${snapshot.derivationDurationMs.toFixed(2)} ms`} />
      <Metric label="Last commit" value={`${snapshot.commitDurationMs.toFixed(2)} ms`} />
      <Metric label="Max commit" value={`${snapshot.maxCommitDurationMs.toFixed(2)} ms`} />
      <Metric
        label="Scroll"
        value={`${snapshot.scrollTop} / ${snapshot.scrollHeight - snapshot.clientHeight}`}
      />
      <Metric label="History requests" value={String(snapshot.historyRequestCount)} />
      <Metric
        label="Last history page"
        value={`${snapshot.lastHistoryLatencyMs.toFixed(1)} ms / ${formatMetricBytes(
          snapshot.lastHistoryPayloadBytes
        )}`}
      />
      <Metric
        label="History bytes total"
        value={formatMetricBytes(snapshot.totalHistoryPayloadBytes)}
      />
      <Metric
        label="Resizes / last delta"
        value={`${snapshot.resizeCount} / ${snapshot.lastResizeDeltaPx.toFixed(1)} px`}
      />
      <Metric label="Layout shift" value={snapshot.layoutShiftScore.toFixed(4)} />
      <Metric
        label="Long tasks"
        value={`${snapshot.longTaskCount} / ${snapshot.longTaskDurationMs.toFixed(1)} ms`}
      />
      <Metric label="JS heap" value={formatMetricBytes(snapshot.heapUsedBytes)} />
    </aside>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 border-t border-border/50 py-0.5">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right" title={value}>
        {value}
      </span>
    </div>
  );
}

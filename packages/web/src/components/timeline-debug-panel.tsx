"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  createTimelineDiagnosticsSnapshot,
  formatMetricBytes,
  type TimelineDiagnosticsSnapshot,
  type TimelineRuntimeMetrics,
  type VisibleTimelineChild,
} from "@/lib/timeline-diagnostics";

interface LayoutShiftEntry extends PerformanceEntry {
  hadRecentInput: boolean;
  value: number;
}

export function TimelineDebugPanel({
  hostRef,
  eventCount,
  runtimeMetricsRef,
  loadedRangeStart,
}: {
  hostRef: RefObject<HTMLDivElement | null>;
  eventCount: number;
  runtimeMetricsRef: RefObject<TimelineRuntimeMetrics>;
  loadedRangeStart: number;
}) {
  const containerRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLElement | null>(null);
  const visibleChildrenRef = useRef(new Map<Element, VisibleTimelineChild>());
  const renderedChildCountRef = useRef(0);
  const domNodeCountRef = useRef<number | null>(null);
  const frameRef = useRef<number | null>(null);
  const [snapshot, setSnapshot] = useState<TimelineDiagnosticsSnapshot | null>(null);

  const collectSnapshot = useCallback(() => {
    setSnapshot(
      createTimelineDiagnosticsSnapshot({
        container: containerRef.current,
        eventCount,
        renderedChildCount: renderedChildCountRef.current,
        domNodeCount: domNodeCountRef.current,
        visibleChildren: visibleChildrenRef.current.values(),
        runtime: runtimeMetricsRef.current,
      })
    );
  }, [eventCount, runtimeMetricsRef]);

  const scheduleSnapshot = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      collectSnapshot();
    });
  }, [collectSnapshot]);

  useEffect(() => {
    const container = hostRef.current?.querySelector<HTMLElement>(".overflow-y-auto") ?? null;
    const content = container?.firstElementChild as HTMLElement | null;
    containerRef.current = container;
    contentRef.current = content;
    visibleChildrenRef.current.clear();
    domNodeCountRef.current = null;
    if (!container || !content) {
      renderedChildCountRef.current = 0;
      collectSnapshot();
      return;
    }

    // The first and last children are timeline scroll sentinels, not rendered events.
    const children = Array.from(content.children).slice(1, -1);
    renderedChildCountRef.current = children.length;
    const indexes = new Map(children.map((child, index) => [child, index]));
    const intersectionObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const index = indexes.get(entry.target);
          if (index === undefined) continue;
          if (entry.isIntersecting) {
            visibleChildrenRef.current.set(entry.target, {
              index,
              top: entry.boundingClientRect.top - (entry.rootBounds?.top ?? 0),
            });
          } else {
            visibleChildrenRef.current.delete(entry.target);
          }
        }
        scheduleSnapshot();
      },
      { root: container }
    );
    children.forEach((child) => intersectionObserver.observe(child));

    let previousHeight: number | null = null;
    const resizeObserver = new ResizeObserver(([entry]) => {
      const height = entry.contentRect.height;
      if (previousHeight !== null && height !== previousHeight) {
        runtimeMetricsRef.current.resizeCount += 1;
        runtimeMetricsRef.current.lastResizeDeltaPx = height - previousHeight;
      }
      previousHeight = height;
      scheduleSnapshot();
    });
    resizeObserver.observe(content);
    collectSnapshot();

    return () => {
      intersectionObserver.disconnect();
      resizeObserver.disconnect();
    };
  }, [collectSnapshot, eventCount, hostRef, runtimeMetricsRef, scheduleSnapshot]);

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
      scheduleSnapshot();
    });
    observe("longtask", (entries) => {
      runtimeMetricsRef.current.longTaskCount += entries.length;
      runtimeMetricsRef.current.longTaskDurationMs += entries.reduce(
        (duration, entry) => duration + entry.duration,
        0
      );
      scheduleSnapshot();
    });
    return () => observers.forEach((observer) => observer.disconnect());
  }, [runtimeMetricsRef, scheduleSnapshot]);

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    []
  );

  const sampleDomNodes = () => {
    domNodeCountRef.current = contentRef.current?.querySelectorAll("*").length ?? 0;
    collectSnapshot();
  };

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
          snapshot.eventCount
            ? `${loadedRangeStart}-${loadedRangeStart + snapshot.eventCount - 1}`
            : "empty"
        }
      />
      <Metric
        label="Events / rendered children"
        value={`${snapshot.eventCount} / ${snapshot.renderedChildCount}`}
      />
      <Metric label="Visible children" value={visibleRange} />
      <Metric label="Anchor child" value={snapshot.anchorIndex?.toString() ?? "none"} />
      <Metric
        label="Anchor offset"
        value={
          snapshot.anchorOffsetPx === null ? "n/a" : `${snapshot.anchorOffsetPx.toFixed(1)} px`
        }
      />
      <Metric label="Last React render" value={`${snapshot.renderDurationMs.toFixed(2)} ms`} />
      <Metric label="Max React render" value={`${snapshot.maxRenderDurationMs.toFixed(2)} ms`} />
      <div className="text-muted-foreground">
        React timing requires a development/profiling build.
      </div>
      <Metric
        label="Scroll"
        value={`${snapshot.scrollTop} / ${snapshot.scrollHeight - snapshot.clientHeight}`}
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
      <div className="mt-2 flex items-center justify-between gap-3 border-t border-border/50 pt-2">
        <button
          type="button"
          className="rounded border border-border px-2 py-0.5 hover:bg-muted"
          onClick={sampleDomNodes}
        >
          Sample DOM nodes
        </button>
        <span>{snapshot.domNodeCount === null ? "not sampled" : snapshot.domNodeCount}</span>
      </div>
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

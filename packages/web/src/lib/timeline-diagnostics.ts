export interface TimelineRuntimeMetrics {
  commitDurationMs: number;
  maxCommitDurationMs: number;
  historyRequestCount: number;
  lastHistoryLatencyMs: number;
  lastHistoryPayloadBytes: number;
  totalHistoryPayloadBytes: number;
  resizeCount: number;
  lastResizeDeltaPx: number;
  layoutShiftScore: number;
  longTaskCount: number;
  longTaskDurationMs: number;
}

export const TIMELINE_HISTORY_METRIC_EVENT = "open-inspect:timeline-history-metric";

export interface TimelineHistoryMetric {
  latencyMs: number;
  payloadBytes: number;
}

export interface TimelineDiagnosticsSnapshot extends TimelineRuntimeMetrics {
  eventCount: number;
  itemCount: number;
  derivationDurationMs: number;
  domNodeCount: number;
  rowCount: number;
  visibleRange: [number, number] | null;
  anchorId: string | null;
  anchorOffsetPx: number | null;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  heapUsedBytes: number | null;
}

interface ChromiumPerformanceMemory {
  usedJSHeapSize: number;
}

export function createTimelineRuntimeMetrics(): TimelineRuntimeMetrics {
  return {
    commitDurationMs: 0,
    maxCommitDurationMs: 0,
    historyRequestCount: 0,
    lastHistoryLatencyMs: 0,
    lastHistoryPayloadBytes: 0,
    totalHistoryPayloadBytes: 0,
    resizeCount: 0,
    lastResizeDeltaPx: 0,
    layoutShiftScore: 0,
    longTaskCount: 0,
    longTaskDurationMs: 0,
  };
}

export function timelineDiagnosticsRequested(): boolean {
  return (
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("timelineDebug") === "1"
  );
}

export function publishTimelineHistoryMetric(metric: TimelineHistoryMetric): void {
  window.dispatchEvent(
    new CustomEvent<TimelineHistoryMetric>(TIMELINE_HISTORY_METRIC_EVENT, { detail: metric })
  );
}

export function collectTimelineDiagnostics({
  container,
  content,
  eventCount,
  itemCount,
  derivationDurationMs,
  runtime,
}: {
  container: HTMLElement | null;
  content: HTMLElement | null;
  eventCount: number;
  itemCount: number;
  derivationDurationMs: number;
  runtime: TimelineRuntimeMetrics;
}): TimelineDiagnosticsSnapshot {
  const rows = content
    ? Array.from(content.querySelectorAll<HTMLElement>("[data-timeline-row]"))
    : [];
  const containerRect = container?.getBoundingClientRect();
  const visibleRows = containerRect
    ? rows
        .map((row, index) => ({ index, row, rect: row.getBoundingClientRect() }))
        .filter(({ rect }) => rect.bottom > containerRect.top && rect.top < containerRect.bottom)
    : [];
  const anchor = visibleRows[0];
  const memory = (performance as typeof performance & { memory?: ChromiumPerformanceMemory })
    .memory;

  return {
    ...runtime,
    eventCount,
    itemCount,
    derivationDurationMs,
    domNodeCount: content?.querySelectorAll("*").length ?? 0,
    rowCount: rows.length,
    visibleRange:
      visibleRows.length > 0
        ? [visibleRows[0].index, visibleRows[visibleRows.length - 1].index]
        : null,
    anchorId: anchor?.row.dataset.timelineRow ?? null,
    anchorOffsetPx: anchor && containerRect ? anchor.rect.top - containerRect.top : null,
    scrollTop: container?.scrollTop ?? 0,
    scrollHeight: container?.scrollHeight ?? 0,
    clientHeight: container?.clientHeight ?? 0,
    heapUsedBytes: memory?.usedJSHeapSize ?? null,
  };
}

export function formatMetricBytes(bytes: number | null): string {
  if (bytes === null) return "unsupported";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

export interface TimelineRuntimeMetrics {
  renderDurationMs: number;
  maxRenderDurationMs: number;
  resizeCount: number;
  lastResizeDeltaPx: number;
  layoutShiftScore: number;
  longTaskCount: number;
  longTaskDurationMs: number;
}

export interface VisibleTimelineChild {
  index: number;
  top: number;
}

export interface TimelineDiagnosticsSnapshot extends TimelineRuntimeMetrics {
  eventCount: number;
  renderedChildCount: number;
  domNodeCount: number | null;
  visibleRange: [number, number] | null;
  anchorIndex: number | null;
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
    renderDurationMs: 0,
    maxRenderDurationMs: 0,
    resizeCount: 0,
    lastResizeDeltaPx: 0,
    layoutShiftScore: 0,
    longTaskCount: 0,
    longTaskDurationMs: 0,
  };
}

export function createTimelineDiagnosticsSnapshot({
  container,
  eventCount,
  renderedChildCount,
  domNodeCount,
  visibleChildren,
  runtime,
}: {
  container: HTMLElement | null;
  eventCount: number;
  renderedChildCount: number;
  domNodeCount: number | null;
  visibleChildren: Iterable<VisibleTimelineChild>;
  runtime: TimelineRuntimeMetrics;
}): TimelineDiagnosticsSnapshot {
  const visible = Array.from(visibleChildren).sort((left, right) => left.index - right.index);
  const anchor = visible.reduce<VisibleTimelineChild | null>(
    (topmost, child) => (!topmost || child.top < topmost.top ? child : topmost),
    null
  );
  const memory = (performance as typeof performance & { memory?: ChromiumPerformanceMemory })
    .memory;

  return {
    ...runtime,
    eventCount,
    renderedChildCount,
    domNodeCount,
    visibleRange: visible.length ? [visible[0].index, visible[visible.length - 1].index] : null,
    anchorIndex: anchor?.index ?? null,
    anchorOffsetPx: anchor?.top ?? null,
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

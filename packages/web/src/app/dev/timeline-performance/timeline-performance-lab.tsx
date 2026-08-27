"use client";

import {
  Profiler,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ProfilerOnRenderCallback,
} from "react";
import { SessionTimeline } from "@/components/session-timeline";
import { TimelineDebugPanel } from "@/components/timeline-debug-panel";
import {
  generateTimelinePerformanceFixture,
  LARGE_SESSION_EVENT_COUNT,
  summarizeTimelinePerformanceFixture,
} from "@/lib/timeline-performance-fixture";
import {
  createTimelineRuntimeMetrics,
  type TimelineRuntimeMetrics,
} from "@/lib/timeline-diagnostics";

const INITIAL_LOADED_EVENTS = 500;
const HISTORY_PAGE_SIZE = 200;
const SESSION_SIZES = [5_000, 25_000, LARGE_SESSION_EVENT_COUNT] as const;

export function TimelinePerformanceLab() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) {
    return (
      <main className="h-screen bg-background" aria-label="Loading timeline performance lab" />
    );
  }
  return <MountedTimelinePerformanceLab />;
}

function MountedTimelinePerformanceLab() {
  const [sessionEventCount, setSessionEventCount] = useState<number>(LARGE_SESSION_EVENT_COUNT);
  const [loadedEventCount, setLoadedEventCount] = useState(INITIAL_LOADED_EVENTS);
  const timelineHostRef = useRef<HTMLDivElement>(null);
  const runtimeMetricsRef = useRef<TimelineRuntimeMetrics>(createTimelineRuntimeMetrics());
  const handleProfilerRender = useCallback<ProfilerOnRenderCallback>(
    (_id, _phase, actualDuration) => {
      runtimeMetricsRef.current.renderDurationMs = actualDuration;
      runtimeMetricsRef.current.maxRenderDurationMs = Math.max(
        runtimeMetricsRef.current.maxRenderDurationMs,
        actualDuration
      );
    },
    []
  );
  const fixture = useMemo(() => {
    const startedAt = performance.now();
    const events = generateTimelinePerformanceFixture(sessionEventCount);
    return { events, generationDurationMs: performance.now() - startedAt };
  }, [sessionEventCount]);
  const summary = useMemo(
    () => summarizeTimelinePerformanceFixture(fixture.events),
    [fixture.events]
  );
  const visibleEvents = useMemo(
    () => fixture.events.slice(-loadedEventCount),
    [fixture.events, loadedEventCount]
  );
  const loadOlder = () =>
    setLoadedEventCount((count) => Math.min(fixture.events.length, count + HISTORY_PAGE_SIZE));

  return (
    <main className="h-screen overflow-hidden bg-background text-foreground">
      <section className="absolute left-3 top-3 z-40 w-80 rounded-md border border-border bg-background/95 p-3 text-xs shadow-xl backdrop-blur">
        <h1 className="text-sm font-semibold">Timeline performance lab</h1>
        <p className="mt-1 text-muted-foreground">
          Deterministic full-session fixture with production timeline rendering and diagnostics.
        </p>
        <label className="mt-3 block font-medium" htmlFor="session-event-count">
          Full session events
        </label>
        <select
          id="session-event-count"
          className="mt-1 w-full rounded border border-border bg-background px-2 py-1"
          value={sessionEventCount}
          onChange={(event) => {
            runtimeMetricsRef.current = createTimelineRuntimeMetrics();
            setSessionEventCount(Number(event.target.value));
            setLoadedEventCount(INITIAL_LOADED_EVENTS);
          }}
        >
          {SESSION_SIZES.map((count) => (
            <option key={count} value={count}>
              {count.toLocaleString("en-US")}
            </option>
          ))}
        </select>
        <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 font-mono">
          <dt className="text-muted-foreground">Loaded</dt>
          <dd>{visibleEvents.length.toLocaleString("en-US")}</dd>
          <dt className="text-muted-foreground">Fixture generation</dt>
          <dd>{fixture.generationDurationMs.toFixed(1)} ms</dd>
          <dt className="text-muted-foreground">Approx. JSON</dt>
          <dd>{(summary.approximateJsonBytes / 1024 / 1024).toFixed(1)} MiB</dd>
        </dl>
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            className="rounded border border-border px-2 py-1 hover:bg-muted disabled:opacity-50"
            disabled={visibleEvents.length === fixture.events.length}
            onClick={loadOlder}
          >
            Load 200 older
          </button>
          <button
            type="button"
            className="rounded border border-border px-2 py-1 hover:bg-muted disabled:opacity-50"
            disabled={visibleEvents.length === fixture.events.length}
            onClick={() => setLoadedEventCount(fixture.events.length)}
          >
            Load all
          </button>
        </div>
      </section>
      <div ref={timelineHostRef} className="h-full">
        <Profiler id="session-timeline" onRender={handleProfilerRender}>
          <SessionTimeline
            events={visibleEvents}
            sessionId="timeline-performance-lab"
            currentParticipantId="participant-performance"
            participantProfiles={{}}
            isProcessing={false}
            loadingHistory={false}
            showSkeleton={false}
            onLoadOlder={loadOlder}
            onOpenMedia={() => {}}
          />
        </Profiler>
        <TimelineDebugPanel
          key={sessionEventCount}
          hostRef={timelineHostRef}
          eventCount={visibleEvents.length}
          runtimeMetricsRef={runtimeMetricsRef}
          loadedRangeStart={fixture.events.length - visibleEvents.length}
        />
      </div>
    </main>
  );
}

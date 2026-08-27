// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTimelineRuntimeMetrics } from "@/lib/timeline-diagnostics";
import { TimelineDebugPanel } from "./timeline-debug-panel";

beforeEach(() => {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    }
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    }
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 0)
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TimelineDebugPanel", () => {
  it("samples the unchanged timeline DOM only on request", async () => {
    function Harness() {
      const hostRef = useRef<HTMLDivElement>(null);
      const runtimeMetricsRef = useRef(createTimelineRuntimeMetrics());
      return (
        <div ref={hostRef}>
          <div className="overflow-y-auto">
            <div data-testid="timeline-content">
              <div />
              <article>
                <span>Rendered row</span>
              </article>
              <div />
            </div>
          </div>
          <TimelineDebugPanel
            hostRef={hostRef}
            eventCount={100}
            runtimeMetricsRef={runtimeMetricsRef}
            loadedRangeStart={900}
          />
        </div>
      );
    }

    const view = render(<Harness />);
    const content = view.getByTestId("timeline-content");
    const querySelectorAll = vi.spyOn(content, "querySelectorAll");
    const panel = await view.findByTestId("timeline-debug-panel");

    expect(panel).toHaveTextContent("100 / 1");
    expect(panel).toHaveTextContent("not sampled");
    expect(querySelectorAll).not.toHaveBeenCalled();

    fireEvent.click(view.getByRole("button", { name: "Sample DOM nodes" }));

    await waitFor(() => expect(panel).toHaveTextContent("4"));
    expect(querySelectorAll).toHaveBeenCalledOnce();
  });
});

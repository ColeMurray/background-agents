import { describe, expect, it } from "vitest";
import type { SandboxEvent } from "@/types/session";
import type { BootProgressEvent } from "@open-inspect/shared/types/sandbox-events";
import type { SessionTimelineEvent } from "@open-inspect/shared/types/server-messages";
import {
  applyBootProgress,
  bootPhaseLabel,
  bootPhaseRepoLabel,
  endBootPhase,
  seedSandboxBoot,
} from "./boot-phase";

function bootProgress(overrides: Partial<BootProgressEvent> = {}): BootProgressEvent {
  return {
    type: "boot_progress",
    bootSeq: 1,
    phase: "sync",
    status: "started",
    sandboxId: "sb-1",
    timestamp: 1,
    ...overrides,
  };
}

function timeline(...events: SandboxEvent[]): {
  events: SessionTimelineEvent[];
  hasMore: boolean;
  cursor: null;
} {
  return {
    events: events.map((event, index) => ({
      eventId: `event-${index}`,
      timelineSequence: index,
      event,
    })),
    hasMore: false,
    cursor: null,
  };
}

describe("seedSandboxBoot", () => {
  it("is null when nothing has booted", () => {
    expect(seedSandboxBoot({ bootPhase: null, timeline: timeline() })).toBeNull();
    expect(
      seedSandboxBoot({
        timeline: timeline({
          type: "git_sync",
          status: "completed",
          sandboxId: "sb-1",
          timestamp: 1,
        }),
      })
    ).toBeNull();
  });

  it("takes the snapshot's phase as authoritative and collects that sandbox's timings", () => {
    const boot = seedSandboxBoot({
      bootPhase: {
        phase: "start",
        status: "failed",
        bootSeq: 6,
        sandboxId: "sb-2",
        outputTail: ["npm ERR! missing script: dev"],
        detail: "start hook failed",
      },
      timeline: timeline(
        // An earlier sandbox's boot: its timings are not this boot's.
        bootProgress({ bootSeq: 2, phase: "sync", status: "completed", elapsedMs: 900 }),
        bootProgress({ bootSeq: 3, phase: "setup", status: "failed", outputTail: ["boom"] }),
        bootProgress({
          sandboxId: "sb-2",
          bootSeq: 2,
          phase: "sync",
          status: "completed",
          elapsedMs: 540,
        }),
        bootProgress({
          sandboxId: "sb-2",
          bootSeq: 4,
          phase: "setup",
          status: "completed",
          warning: true,
          repoOwner: "acme",
          repoName: "web",
          elapsedMs: 91_200,
        }),
        bootProgress({ sandboxId: "sb-2", bootSeq: 6, phase: "start", status: "failed" })
      ),
    });

    expect(boot).toEqual({
      sandboxId: "sb-2",
      phase: {
        phase: "start",
        status: "failed",
        bootSeq: 6,
        sandboxId: "sb-2",
        outputTail: ["npm ERR! missing script: dev"],
        detail: "start hook failed",
      },
      timings: [
        { phase: "sync", elapsedMs: 540 },
        { phase: "setup", elapsedMs: 91_200, warning: true, repoOwner: "acme", repoName: "web" },
      ],
    });
  });

  it("separates boots by the sandbox that reported, not by sequence rollback", () => {
    // The bridge sends only its latest phase when it connects, so the next
    // sandbox's first persisted report can carry a higher sequence than the
    // previous sandbox's last one.
    const boot = seedSandboxBoot({
      bootPhase: { phase: "harness", status: "started", bootSeq: 5, sandboxId: "sb-2" },
      timeline: timeline(
        bootProgress({ bootSeq: 2, phase: "sync", status: "completed", elapsedMs: 900 }),
        bootProgress({ bootSeq: 3, phase: "setup", status: "failed" }),
        bootProgress({
          sandboxId: "sb-2",
          bootSeq: 4,
          phase: "start",
          status: "completed",
          elapsedMs: 300,
        }),
        bootProgress({ sandboxId: "sb-2", bootSeq: 5, phase: "harness", status: "started" })
      ),
    });

    expect(boot?.timings).toEqual([{ phase: "start", elapsedMs: 300 }]);
  });

  it("keeps a finished boot's timings once the snapshot names no phase", () => {
    const boot = seedSandboxBoot({
      bootPhase: null,
      timeline: timeline(
        bootProgress({ bootSeq: 2, phase: "sync", status: "completed", elapsedMs: 900 }),
        bootProgress({
          sandboxId: "sb-2",
          bootSeq: 2,
          phase: "sync",
          status: "completed",
          elapsedMs: 540,
        }),
        bootProgress({
          sandboxId: "sb-2",
          bootSeq: 10,
          phase: "harness",
          status: "completed",
          elapsedMs: 3_000,
        })
      ),
    });

    expect(boot).toEqual({
      sandboxId: "sb-2",
      phase: null,
      timings: [
        { phase: "sync", elapsedMs: 540 },
        { phase: "harness", elapsedMs: 3_000 },
      ],
    });
  });

  it("skips a completed phase that reports no duration", () => {
    const boot = seedSandboxBoot({
      bootPhase: null,
      timeline: timeline(bootProgress({ bootSeq: 2, phase: "sync", status: "completed" })),
    });

    expect(boot?.timings).toEqual([]);
  });
});

describe("applyBootProgress", () => {
  it("advances the boot it belongs to and keeps its timings", () => {
    const boot = applyBootProgress(
      { sandboxId: "sb-1", phase: { phase: "sync", status: "started" }, timings: [] },
      bootProgress({ bootSeq: 2, phase: "sync", status: "completed", elapsedMs: 800 })
    );

    expect(boot).toEqual({
      sandboxId: "sb-1",
      phase: { bootSeq: 2, phase: "sync", status: "completed", elapsedMs: 800, sandboxId: "sb-1" },
      timings: [{ phase: "sync", elapsedMs: 800 }],
    });
  });

  it("starts a new boot when a different sandbox reports", () => {
    const boot = applyBootProgress(
      {
        sandboxId: "sb-1",
        phase: { phase: "start", status: "failed" },
        timings: [{ phase: "sync", elapsedMs: 900 }],
      },
      bootProgress({ sandboxId: "sb-2", bootSeq: 4, phase: "setup", status: "started" })
    );

    expect(boot).toEqual({
      sandboxId: "sb-2",
      phase: { bootSeq: 4, phase: "setup", status: "started", sandboxId: "sb-2" },
      timings: [],
    });
  });

  it("starts the first boot from nothing", () => {
    expect(applyBootProgress(null, bootProgress())).toEqual({
      sandboxId: "sb-1",
      phase: { bootSeq: 1, phase: "sync", status: "started", sandboxId: "sb-1" },
      timings: [],
    });
  });
});

describe("endBootPhase", () => {
  it("drops the phase and keeps the timings", () => {
    expect(
      endBootPhase({
        sandboxId: "sb-1",
        phase: { phase: "harness", status: "completed" },
        timings: [{ phase: "sync", elapsedMs: 900 }],
      })
    ).toEqual({ sandboxId: "sb-1", phase: null, timings: [{ phase: "sync", elapsedMs: 900 }] });
    expect(endBootPhase(null)).toBeNull();
  });
});

describe("labels", () => {
  it("names every phase", () => {
    expect(bootPhaseLabel("starting")).toBe("Starting runtime");
    expect(bootPhaseLabel("sync")).toBe("Cloning repository");
    expect(bootPhaseLabel("setup")).toBe("Running setup.sh");
    expect(bootPhaseLabel("start")).toBe("Starting services");
    expect(bootPhaseLabel("skills")).toBe("Installing skills");
    expect(bootPhaseLabel("harness")).toBe("Starting agent");
  });

  it("names the repository only for multi-repository sessions", () => {
    const progress = { repoOwner: "acme", repoName: "api" };
    expect(bootPhaseRepoLabel(progress, 2)).toBe("acme/api");
    expect(bootPhaseRepoLabel(progress, 1)).toBeNull();
    expect(bootPhaseRepoLabel({}, 2)).toBeNull();
  });
});

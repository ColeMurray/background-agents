import { describe, expect, it } from "vitest";
import type { SandboxEvent } from "@/types/session";
import type { SessionTimelineEvent } from "@open-inspect/shared/types/server-messages";
import {
  bootPhaseLabel,
  bootPhaseRepoLabel,
  bootProgressFromEvent,
  collectBootPhaseTimings,
  formatBootDuration,
  seedBootProgress,
  type BootProgressEvent,
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

function timelineEvent(event: SandboxEvent, sequence: number): SessionTimelineEvent {
  return { eventId: `event-${sequence}`, timelineSequence: sequence, event };
}

describe("bootProgressFromEvent", () => {
  it("keeps the phase identity and what only the timeline copy carries", () => {
    expect(
      bootProgressFromEvent(
        bootProgress({
          bootSeq: 7,
          phase: "start",
          status: "failed",
          repoOwner: "acme",
          repoName: "web",
          outputTail: ["npm ERR! missing script: dev"],
          detail: "start hook failed for acme/web",
        })
      )
    ).toEqual({
      phase: "start",
      status: "failed",
      bootSeq: 7,
      repoOwner: "acme",
      repoName: "web",
      outputTail: ["npm ERR! missing script: dev"],
      detail: "start hook failed for acme/web",
    });
  });

  it("omits fields the event did not carry", () => {
    expect(bootProgressFromEvent(bootProgress())).toEqual({
      phase: "sync",
      status: "started",
      bootSeq: 1,
    });
  });
});

describe("seedBootProgress", () => {
  it("is null when the snapshot names no phase", () => {
    expect(
      seedBootProgress({ bootPhase: null, timeline: { events: [], hasMore: false, cursor: null } })
    ).toBeNull();
    expect(seedBootProgress({ timeline: { events: [], hasMore: false, cursor: null } })).toBeNull();
  });

  it("takes the timeline copy of the snapshot's phase so a reload keeps the tail", () => {
    const seeded = seedBootProgress({
      bootPhase: { phase: "setup", status: "failed", repoOwner: "acme", repoName: "web" },
      timeline: {
        events: [
          timelineEvent(bootProgress({ bootSeq: 3, phase: "setup", status: "started" }), 1),
          timelineEvent(
            bootProgress({
              bootSeq: 4,
              phase: "setup",
              status: "failed",
              repoOwner: "acme",
              repoName: "web",
              outputTail: ["error: exit 3"],
              detail: "setup hook failed",
            }),
            2
          ),
        ],
        hasMore: false,
        cursor: null,
      },
    });

    expect(seeded).toEqual({
      phase: "setup",
      status: "failed",
      bootSeq: 4,
      repoOwner: "acme",
      repoName: "web",
      outputTail: ["error: exit 3"],
      detail: "setup hook failed",
    });
  });

  it("falls back to the snapshot's phase when the timeline page holds a different line", () => {
    const seeded = seedBootProgress({
      bootPhase: { phase: "skills", status: "started" },
      timeline: {
        events: [
          // An earlier boot's failure is not this boot's phase.
          timelineEvent(
            bootProgress({ bootSeq: 9, phase: "start", status: "failed", outputTail: ["boom"] }),
            1
          ),
        ],
        hasMore: true,
        cursor: null,
      },
    });

    expect(seeded).toEqual({ phase: "skills", status: "started" });
  });
});

describe("collectBootPhaseTimings", () => {
  it("reports the completed phases of the latest boot only, in order", () => {
    const events: SandboxEvent[] = [
      bootProgress({ bootSeq: 1, phase: "sync", status: "started" }),
      bootProgress({ bootSeq: 2, phase: "sync", status: "completed", elapsedMs: 900 }),
      bootProgress({ bootSeq: 3, phase: "start", status: "failed", outputTail: ["boom"] }),
      // The next generation restarts the sequence.
      bootProgress({ bootSeq: 1, phase: "sync", status: "started" }),
      bootProgress({ bootSeq: 2, phase: "sync", status: "completed", elapsedMs: 540 }),
      {
        type: "git_sync",
        status: "completed",
        sandboxId: "sb-2",
        timestamp: 5,
      },
      bootProgress({
        bootSeq: 3,
        phase: "setup",
        status: "started",
        repoOwner: "acme",
        repoName: "web",
      }),
      bootProgress({
        bootSeq: 4,
        phase: "setup",
        status: "completed",
        warning: true,
        repoOwner: "acme",
        repoName: "web",
        elapsedMs: 91_200,
      }),
      bootProgress({ bootSeq: 5, phase: "harness", status: "started" }),
    ];

    expect(collectBootPhaseTimings(events)).toEqual([
      { phase: "sync", elapsedMs: 540 },
      { phase: "setup", elapsedMs: 91_200, warning: true, repoOwner: "acme", repoName: "web" },
    ]);
  });

  it("is empty for a timeline without boot phases", () => {
    expect(
      collectBootPhaseTimings([
        { type: "git_sync", status: "completed", sandboxId: "sb-1", timestamp: 1 },
      ])
    ).toEqual([]);
  });

  it("skips a completed phase that reports no duration", () => {
    expect(
      collectBootPhaseTimings([bootProgress({ bootSeq: 2, phase: "sync", status: "completed" })])
    ).toEqual([]);
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

describe("formatBootDuration", () => {
  it("shows tenths under a minute and minutes above", () => {
    expect(formatBootDuration(420)).toBe("0.4s");
    expect(formatBootDuration(91_240)).toBe("1m 31s");
    expect(formatBootDuration(59_960)).toBe("1m 00s");
    expect(formatBootDuration(125_000)).toBe("2m 05s");
    expect(formatBootDuration(-5)).toBe("0.0s");
  });
});

import type { SandboxEvent } from "@/types/session";
import {
  toSandboxBootPhase,
  type BootPhaseName,
  type BootProgressEvent,
  type SandboxBootPhase,
} from "@open-inspect/shared/types/sandbox-events";
import type { SessionSnapshot } from "@open-inspect/shared/types/server-messages";

/** A phase of a boot that completed, with how long it took. */
export interface BootPhaseTiming {
  phase: BootPhaseName;
  elapsedMs: number;
  warning?: boolean;
  repoOwner?: string;
  repoName?: string;
}

/**
 * The latest sandbox boot as the client knows it. One boot is one sandbox:
 * every `boot_progress` event carries the id of the sandbox that reported
 * it, so a report from a different sandbox is a different boot, however its
 * sequence numbers compare. `phase` is the last report and is null once the
 * boot is over; `timings` keeps every completed phase of this boot.
 */
export interface SandboxBoot {
  sandboxId: string | undefined;
  phase: SandboxBootPhase | null;
  timings: BootPhaseTiming[];
}

const BOOT_PHASE_LABELS: Record<BootPhaseName, string> = {
  starting: "Starting runtime",
  sync: "Cloning repository",
  setup: "Running setup.sh",
  start: "Starting services",
  skills: "Installing skills",
  harness: "Starting agent",
};

export function bootPhaseLabel(phase: BootPhaseName): string {
  return BOOT_PHASE_LABELS[phase];
}

/**
 * The repository a phase names, for sessions where that disambiguates. A
 * single-repository session runs every phase against its one repository, so
 * naming it there is noise.
 */
export function bootPhaseRepoLabel(
  progress: Pick<SandboxBootPhase, "repoOwner" | "repoName">,
  repositoryCount: number
): string | null {
  if (repositoryCount < 2 || !progress.repoOwner || !progress.repoName) return null;
  return `${progress.repoOwner}/${progress.repoName}`;
}

function isBootProgress(event: SandboxEvent): event is BootProgressEvent {
  return event.type === "boot_progress";
}

function bootPhaseTiming(event: BootProgressEvent): BootPhaseTiming | null {
  if (event.status !== "completed" || event.elapsedMs === undefined) return null;
  return {
    phase: event.phase,
    elapsedMs: event.elapsedMs,
    ...(event.warning !== undefined ? { warning: event.warning } : {}),
    ...(event.repoOwner !== undefined ? { repoOwner: event.repoOwner } : {}),
    ...(event.repoName !== undefined ? { repoName: event.repoName } : {}),
  };
}

/**
 * The boot a snapshot describes. The snapshot's `bootPhase` is the latest
 * report of a boot still going or just failed; the timeline page holds
 * every report the sandbox made, from which the completed phases of that
 * same sandbox are collected. Once a boot is over the snapshot names no
 * phase, and the boot is whichever sandbox reported last.
 */
export function seedSandboxBoot(
  snapshot: Pick<SessionSnapshot, "bootPhase" | "timeline">
): SandboxBoot | null {
  const reports = snapshot.timeline.events.map((item) => item.event).filter(isBootProgress);
  const phase = snapshot.bootPhase ?? null;
  const last = reports.at(-1);
  if (!phase && !last) return null;
  const sandboxId = phase?.sandboxId ?? last?.sandboxId;
  return {
    sandboxId,
    phase,
    timings: reports
      .filter((report) => report.sandboxId === sandboxId)
      .flatMap((report) => bootPhaseTiming(report) ?? []),
  };
}

/** Apply a live report: it advances the boot it belongs to or starts the next one. */
export function applyBootProgress(boot: SandboxBoot | null, event: BootProgressEvent): SandboxBoot {
  const timing = bootPhaseTiming(event);
  const phase = toSandboxBootPhase(event);
  if (!boot || boot.sandboxId !== event.sandboxId) {
    return { sandboxId: event.sandboxId, phase, timings: timing ? [timing] : [] };
  }
  return { ...boot, phase, timings: timing ? [...boot.timings, timing] : boot.timings };
}

/** The boot is over (ready, or the sandbox is gone): its phase no longer describes anything. */
export function endBootPhase(boot: SandboxBoot | null): SandboxBoot | null {
  return boot?.phase ? { ...boot, phase: null } : boot;
}

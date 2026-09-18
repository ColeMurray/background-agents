import type { SandboxEvent } from "@/types/session";
import type { BootPhaseName, SandboxBootPhase } from "@open-inspect/shared/types/sandbox-events";
import type { SessionSnapshot } from "@open-inspect/shared/types/server-messages";

export type BootProgressEvent = Extract<SandboxEvent, { type: "boot_progress" }>;

/**
 * The boot phase the view tracks while a sandbox boots: the snapshot's shape
 * plus what only the timeline copy of the same line carries — the failing
 * script's output tail and the phase's error.
 */
export interface SandboxBootProgress extends SandboxBootPhase {
  bootSeq?: number;
  elapsedMs?: number;
  outputTail?: string[];
  detail?: string;
}

/** A phase of the most recent boot that completed, with how long it took. */
export interface BootPhaseTiming {
  phase: BootPhaseName;
  elapsedMs: number;
  warning?: boolean;
  repoOwner?: string;
  repoName?: string;
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
  progress: Pick<SandboxBootProgress, "repoOwner" | "repoName">,
  repositoryCount: number
): string | null {
  if (repositoryCount < 2 || !progress.repoOwner || !progress.repoName) return null;
  return `${progress.repoOwner}/${progress.repoName}`;
}

export function bootProgressFromEvent(event: BootProgressEvent): SandboxBootProgress {
  return {
    phase: event.phase,
    status: event.status,
    bootSeq: event.bootSeq,
    ...(event.warning !== undefined ? { warning: event.warning } : {}),
    ...(event.repoOwner !== undefined ? { repoOwner: event.repoOwner } : {}),
    ...(event.repoName !== undefined ? { repoName: event.repoName } : {}),
    ...(event.elapsedMs !== undefined ? { elapsedMs: event.elapsedMs } : {}),
    ...(event.outputTail !== undefined ? { outputTail: event.outputTail } : {}),
    ...(event.detail !== undefined ? { detail: event.detail } : {}),
  };
}

function isSamePhase(event: BootProgressEvent, phase: SandboxBootPhase): boolean {
  return (
    event.phase === phase.phase &&
    event.status === phase.status &&
    event.repoOwner === phase.repoOwner &&
    event.repoName === phase.repoName
  );
}

/**
 * The boot phase a snapshot describes. The snapshot names the phase; when
 * the timeline page holds the same line, that copy carries the output tail
 * and the error too, so a reload of a failed boot still shows them.
 */
export function seedBootProgress(
  snapshot: Pick<SessionSnapshot, "bootPhase" | "timeline">
): SandboxBootProgress | null {
  const phase = snapshot.bootPhase;
  if (!phase) return null;
  const events = snapshot.timeline.events;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index].event;
    if (event.type !== "boot_progress") continue;
    return isSamePhase(event, phase) ? bootProgressFromEvent(event) : { ...phase };
  }
  return { ...phase };
}

/**
 * Completed phases of the most recent boot, in order, with their durations.
 * The timeline keeps every boot's phases; a sequence number that does not
 * advance marks where a later boot began, and only that boot is reported.
 */
export function collectBootPhaseTimings(events: readonly SandboxEvent[]): BootPhaseTiming[] {
  let timings: BootPhaseTiming[] = [];
  let lastSeq: number | null = null;
  for (const event of events) {
    if (event.type !== "boot_progress") continue;
    if (lastSeq !== null && event.bootSeq <= lastSeq) {
      timings = [];
    }
    lastSeq = event.bootSeq;
    if (event.status !== "completed" || event.elapsedMs === undefined) continue;
    timings.push({
      phase: event.phase,
      elapsedMs: event.elapsedMs,
      ...(event.warning !== undefined ? { warning: event.warning } : {}),
      ...(event.repoOwner !== undefined ? { repoOwner: event.repoOwner } : {}),
      ...(event.repoName !== undefined ? { repoName: event.repoName } : {}),
    });
  }
  return timings;
}

/** "0.4s", "91.2s", "2m 03s": enough precision to tell a slow step from a fast one. */
export function formatBootDuration(elapsedMs: number): string {
  const tenths = Math.round(Math.max(elapsedMs, 0) / 100) / 10;
  if (tenths < 60) return `${tenths.toFixed(1)}s`;
  const totalSeconds = Math.round(tenths);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

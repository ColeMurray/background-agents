import type { SandboxExecutionEvent } from "@open-inspect/shared";

interface CommandEventStore {
  recordAccepted(commandId: string, now: number): boolean;
  recordStarted(commandId: string, now: number): boolean;
  recordOutput(
    event: Extract<SandboxExecutionEvent, { type: "command_output" }>,
    now: number
  ): "recorded" | "duplicate" | "truncated";
  complete(
    event: Extract<SandboxExecutionEvent, { type: "command_completed" }>,
    now: number
  ): boolean;
  recordReplayGap(commandId: string, error: string, now: number): boolean;
}

/** Applies execution-bridge events only to the private command ledger. */
export class SandboxCommandEventHandler {
  constructor(
    private readonly repository: CommandEventStore,
    private readonly now: () => number,
    private readonly onTerminal: () => void = () => {}
  ) {}

  handle(event: SandboxExecutionEvent): void {
    const now = this.now();
    switch (event.type) {
      case "command_accepted":
        this.repository.recordAccepted(event.commandId, now);
        return;
      case "command_started":
        this.repository.recordStarted(event.commandId, now);
        return;
      case "command_output":
        this.repository.recordOutput(event, now);
        return;
      case "command_completed":
        this.repository.complete(event, now);
        this.onTerminal();
        return;
      case "command_replay_gap":
        this.repository.recordReplayGap(
          event.commandId,
          `Command output replay gap: ${event.reason}`,
          now
        );
        this.onTerminal();
        return;
      default:
        event satisfies never;
    }
  }
}

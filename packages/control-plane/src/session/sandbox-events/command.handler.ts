import type { SandboxExecutionEvent } from "@open-inspect/shared";

interface CommandEventStore {
  recordStarted(commandId: string, now: number): boolean;
  recordOutput(
    event: Extract<SandboxExecutionEvent, { type: "command_output" }>,
    now: number
  ): "recorded" | "duplicate" | "truncated";
  complete(
    event: Extract<SandboxExecutionEvent, { type: "command_completed" }>,
    now: number
  ): boolean;
  markIndeterminate(commandId: string, error: string, now: number): boolean;
}

/** Applies execution-bridge events only to the private command ledger. */
export class SandboxCommandEventHandler {
  constructor(
    private readonly repository: CommandEventStore,
    private readonly now: () => number
  ) {}

  handle(event: SandboxExecutionEvent): void {
    const now = this.now();
    switch (event.type) {
      case "command_started":
        this.repository.recordStarted(event.commandId, now);
        return;
      case "command_output":
        this.repository.recordOutput(event, now);
        return;
      case "command_completed":
        this.repository.complete(event, now);
        return;
      case "command_replay_gap":
        this.repository.markIndeterminate(
          event.commandId,
          `Command output replay gap: ${event.reason}`,
          now
        );
        return;
      default:
        event satisfies never;
    }
  }
}

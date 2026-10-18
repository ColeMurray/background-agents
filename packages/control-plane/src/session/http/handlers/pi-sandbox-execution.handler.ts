import { sandboxExecutionCommandSchema } from "@open-inspect/shared";

interface PiSandboxExecutionHandlerDependencies {
  execution: {
    submit(
      command: {
        type: "command_execute";
        effect: "sandbox_execution";
        commandId: string;
        purpose: "shell" | "build" | "test";
        argv: string[];
        cwd?: string;
        timeoutMs?: number;
      },
      operationId: string
    ): Promise<void>;
    cancel(commandId: string): string;
  };
  commands: { get(commandId: string): { operationId: string } | null };
  getProcessingMessageId(): string | null;
}

/** Internal-only boundary; no model-visible extension registers this capability. */
export class PiSandboxExecutionHandler {
  constructor(private readonly deps: PiSandboxExecutionHandlerDependencies) {}

  async handle(request: Request): Promise<Response> {
    const operationId = request.headers.get("X-Pi-Operation-ID");
    if (!operationId || this.deps.getProcessingMessageId() !== operationId) {
      return Response.json({ error: "Pi operation is not active" }, { status: 409 });
    }
    let input: unknown;
    try {
      input = await request.json();
    } catch {
      return Response.json({ error: "Invalid command request" }, { status: 400 });
    }
    const parsed = sandboxExecutionCommandSchema.safeParse(input);
    if (!parsed.success || parsed.data.type === "command_replay") {
      return Response.json({ error: "Invalid command request" }, { status: 400 });
    }
    try {
      if (parsed.data.type === "command_execute") {
        await this.deps.execution.submit(parsed.data, operationId);
      } else {
        const command = this.deps.commands.get(parsed.data.commandId);
        if (!command || command.operationId !== operationId) {
          return Response.json(
            { error: "Command does not belong to this operation" },
            { status: 409 }
          );
        }
        this.deps.execution.cancel(parsed.data.commandId);
      }
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Command execution unavailable" },
        { status: 503 }
      );
    }
    return Response.json({ accepted: true }, { status: 202 });
  }
}

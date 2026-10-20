import type { SandboxCommandRecord, SandboxCommandState } from "../../sandbox-command-repository";
import { publicCommand } from "./pi-sandbox-execution.handler";

interface PiExecutionsHandlerDependencies {
  commands: {
    get(commandId: string): SandboxCommandRecord | null;
    listRecent(limit?: number): SandboxCommandRecord[];
    outputPage(
      commandId: string,
      afterSequence: number,
      limitBytes: number
    ): { chunks: SandboxCommandRecord["output"]; nextSequence: number | null };
  };
  execution: { cancel(commandId: string): SandboxCommandState };
}

export class PiExecutionsHandler {
  constructor(private readonly deps: PiExecutionsHandlerDependencies) {}

  list(request: Request): Response {
    const requested = Number(new URL(request.url).searchParams.get("limit") ?? "50");
    const limit = Number.isInteger(requested) ? requested : 50;
    return Response.json({ commands: this.deps.commands.listRecent(limit).map(publicCommand) });
  }

  cancel(request: Request): Response {
    const commandId = new URL(request.url).searchParams.get("commandId");
    if (!commandId) return Response.json({ error: "Command ID is required" }, { status: 400 });
    if (!this.deps.commands.get(commandId)) {
      return Response.json({ error: "Execution command not found" }, { status: 404 });
    }
    return Response.json({ accepted: true, state: this.deps.execution.cancel(commandId) });
  }

  output(request: Request): Response {
    const url = new URL(request.url);
    const commandId = url.searchParams.get("commandId");
    if (!commandId || !this.deps.commands.get(commandId)) {
      return Response.json({ error: "Execution command not found" }, { status: 404 });
    }
    const afterSequence = Number(url.searchParams.get("afterSequence") ?? "-1");
    const limitBytes = Number(url.searchParams.get("limitBytes") ?? String(64 * 1024));
    if (!Number.isInteger(afterSequence) || afterSequence < -1 || !Number.isInteger(limitBytes)) {
      return Response.json({ error: "Invalid output cursor" }, { status: 400 });
    }
    return Response.json(this.deps.commands.outputPage(commandId, afterSequence, limitBytes));
  }
}

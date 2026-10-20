import { sandboxExecutionCommandSchema } from "@open-inspect/shared";
import { z } from "zod";
import { hashToken } from "../../../auth/crypto";
import type {
  SandboxCommandAuthority,
  SandboxCommandRecord,
} from "../../sandbox-command-repository";

const EXECUTION_APPROVAL_REVISION = 1;
const EXECUTION_CREDENTIAL_PROFILE = "execution-ws-v1";
const EXECUTION_EGRESS_PROFILE = "package-install-v1";

const requestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("submit"),
      command: sandboxExecutionCommandSchema,
      taskId: z.number().int().positive(),
      toolCallId: z.string().min(1).max(256),
      approvalRevision: z.literal(EXECUTION_APPROVAL_REVISION),
    })
    .strict(),
  z
    .object({
      action: z.literal("status"),
      commandId: z.string().min(1).max(128),
      afterSequence: z.number().int().min(-1).default(-1),
      limitBytes: z
        .number()
        .int()
        .positive()
        .max(64 * 1024)
        .default(64 * 1024),
    })
    .strict(),
  z.object({ action: z.literal("cancel"), commandId: z.string().min(1).max(128) }).strict(),
  z.object({ action: z.literal("cancel_operation") }).strict(),
]);

interface PiSandboxExecutionHandlerDependencies {
  execution: {
    submit(
      command: Extract<z.infer<typeof sandboxExecutionCommandSchema>, { type: "command_execute" }>,
      operationId: string,
      authority: SandboxCommandAuthority
    ): Promise<SandboxCommandRecord>;
    cancel(commandId: string): string;
    cancelOperation(operationId: string): string[];
  };
  commands: {
    get(commandId: string): SandboxCommandRecord | null;
    outputPage(
      commandId: string,
      afterSequence: number,
      limitBytes: number
    ): { chunks: SandboxCommandRecord["output"]; nextSequence: number | null };
  };
  getProcessingMessageId(): string | null;
  getOperationActor(operationId: string): { kind: "user" | "service"; id: string } | null;
  /**
   * The session's own capability for sandbox execution.
   *
   * It is the session's authority, not the caller's, that decides whether a
   * new command may run.
   */
  sessionCapability(): "off" | "read_only" | "enabled";
  /**
   * The live deployment mode.
   *
   * A live deny stops new submissions. A command that was already admitted
   * keeps its status, its output, and its cancellation reachable, so an
   * emergency never strands work in flight.
   */
  liveMode(): "off" | "read_only" | "enabled";
}

/** SessionDO-owned execution authority. Reachable only from the private Pi bridge. */
export class PiSandboxExecutionHandler {
  constructor(private readonly deps: PiSandboxExecutionHandlerDependencies) {}

  async handle(request: Request): Promise<Response> {
    const operationId = request.headers.get("X-Pi-Operation-ID");
    if (!operationId) return Response.json({ error: "Pi operation is required" }, { status: 400 });
    const parsed = requestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success)
      return Response.json({ error: "Invalid command request" }, { status: 400 });
    const input = parsed.data;
    const active = this.deps.getProcessingMessageId() === operationId;
    if (!active && input.action !== "cancel_operation" && input.action !== "cancel") {
      return Response.json({ error: "Pi operation is not active" }, { status: 409 });
    }

    try {
      if (input.action === "submit") {
        if (input.command.type !== "command_execute") {
          return Response.json({ error: "Invalid command request" }, { status: 400 });
        }
        // The session decides whether a new command may run. The body may
        // echo the approval revision, but it never grants one.
        if (this.deps.sessionCapability() === "off" || this.deps.liveMode() === "off") {
          return Response.json(
            {
              error: "Sandbox execution is disabled for this session",
              code: "sandbox_execution_disabled",
            },
            { status: 403 }
          );
        }
        const actor = this.deps.getOperationActor(operationId);
        if (!actor)
          return Response.json({ error: "Pi operation actor is unavailable" }, { status: 409 });
        const authority = await commandAuthority(input, actor, operationId);
        const command = await this.deps.execution.submit(input.command, operationId, authority);
        return Response.json({ accepted: true, command: publicCommand(command) }, { status: 202 });
      }

      if (input.action === "cancel_operation") {
        return Response.json({
          accepted: true,
          states: this.deps.execution.cancelOperation(operationId),
        });
      }

      const command = this.deps.commands.get(input.commandId);
      if (!command || command.operationId !== operationId) {
        return Response.json(
          { error: "Command does not belong to this operation" },
          { status: 409 }
        );
      }
      if (input.action === "cancel") {
        return Response.json({
          accepted: true,
          state: this.deps.execution.cancel(input.commandId),
        });
      }
      const page = this.deps.commands.outputPage(
        input.commandId,
        input.afterSequence,
        input.limitBytes
      );
      return Response.json({ command: publicCommand(command), ...page });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Command execution unavailable" },
        { status: 503 }
      );
    }
  }
}

async function commandAuthority(
  input: Extract<z.infer<typeof requestSchema>, { action: "submit" }>,
  actor: { kind: "user" | "service"; id: string },
  operationId: string
): Promise<SandboxCommandAuthority> {
  const immutable = {
    operationId,
    command: input.command,
    actor,
    // The session records its own approval revision, so the ledger never
    // depends on the caller's assertion.
    approvalRevision: EXECUTION_APPROVAL_REVISION,
    credentialProfile: EXECUTION_CREDENTIAL_PROFILE,
    egressProfile: EXECUTION_EGRESS_PROFILE,
    taskId: input.taskId,
    toolCallId: input.toolCallId,
  };
  return {
    fingerprint: await hashToken(JSON.stringify(immutable)),
    actorKind: actor.kind,
    actorId: actor.id,
    approvalRevision: EXECUTION_APPROVAL_REVISION,
    credentialProfile: EXECUTION_CREDENTIAL_PROFILE,
    egressProfile: EXECUTION_EGRESS_PROFILE,
    taskId: input.taskId,
    toolCallId: input.toolCallId,
  };
}

export function publicCommand(command: SandboxCommandRecord) {
  return {
    id: command.id,
    operationId: command.operationId,
    purpose: command.request.purpose,
    state: command.state,
    actor: command.authority
      ? { kind: command.authority.actorKind, id: command.authority.actorId }
      : null,
    approvalRevision: command.authority?.approvalRevision ?? null,
    outputBytes: command.outputBytes,
    outputTruncated: command.outputTruncated,
    exitCode: command.exitCode,
    signal: command.signal,
    error: command.error,
    createdAt: command.createdAt,
    startedAt: command.startedAt,
    completedAt: command.completedAt,
    replayGap: command.replayGap,
  };
}

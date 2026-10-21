import {
  memorySearchSchema,
  sandboxMemoryReadSchema,
  sandboxMemoryWriteSchema,
} from "@open-inspect/shared/types/memories";
import { MEMORY_ERROR_STATUS, MemoryError } from "../../../memory/errors";
import type { SessionMemoryService } from "../../../memory/session-memory-service";

/**
 * The memory gateway inside the owning session.
 *
 * A Pi session reaches the tenant's memory only through its own session
 * runtime. The runtime owns the identity — the session's own row, never the
 * request body — and calls the same `SessionMemoryService` the sandbox path
 * calls, so both surfaces share one authority: the same partitions, the same
 * session selection, the same shared-memory access policy, the same approval
 * rule for a shared write, and the same audit.
 *
 * The route is internal and binding-only: the caller holds the session's
 * Durable Object binding, and every operation must belong to a live turn of
 * this session.
 */
export interface PiMemoryHandlerOptions {
  /** This session's identity. Never taken from the request body. */
  getSessionId(): string;
  /** The memory service for one request, over the session's own global store. */
  service(requestId: string): SessionMemoryService;
  /** Whether the request belongs to a live turn of this session. */
  activeOperation(request: Request): boolean;
}

export class PiMemoryHandler {
  constructor(private readonly options: PiMemoryHandlerOptions) {}

  /** Read one fact by id. */
  async read(request: Request): Promise<Response> {
    return this.run(request, async (service, sessionId) => {
      const parsed = sandboxMemoryReadSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return this.invalid("Invalid memory read");
      return Response.json(await service.read(sessionId, parsed.data.memoryId));
    });
  }

  /** Write one fact or directive, relative to the session. */
  async write(request: Request): Promise<Response> {
    return this.run(request, async (service, sessionId) => {
      const parsed = sandboxMemoryWriteSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return this.invalid("Invalid memory write");
      return Response.json(await service.write(sessionId, parsed.data), { status: 201 });
    });
  }

  /** Search the session's current facts. */
  async search(request: Request): Promise<Response> {
    return this.run(request, async (service, sessionId) => {
      const parsed = memorySearchSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return this.invalid("Invalid memory search");
      return Response.json(await service.search(sessionId, parsed.data));
    });
  }

  /**
   * Whether this session may write this memory right now.
   *
   * The pre-flight a caller asks before it commits to the write. It resolves
   * the same target and applies the same access policy the write applies, so
   * the answer and the write can never disagree.
   */
  async authorizeWrite(request: Request): Promise<Response> {
    return this.run(request, async (service, sessionId) => {
      const parsed = sandboxMemoryWriteSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return this.invalid("Invalid memory write");
      return Response.json(await service.authorizeWrite(sessionId, parsed.data));
    });
  }

  /**
   * One admitted operation.
   *
   * The operation fence comes first: without a live turn of this session,
   * there is no agent to answer to and nothing to attribute the effect to.
   */
  private async run(
    request: Request,
    operation: (service: SessionMemoryService, sessionId: string) => Promise<Response>
  ): Promise<Response> {
    if (!this.options.activeOperation(request)) {
      return Response.json({ error: "Pi execution is not active" }, { status: 409 });
    }
    const service = this.options.service(this.requestId(request));
    try {
      return await operation(service, this.options.getSessionId());
    } catch (cause) {
      if (cause instanceof MemoryError) {
        return Response.json({ error: cause.message }, { status: MEMORY_ERROR_STATUS[cause.kind] });
      }
      throw cause;
    }
  }

  /** The request id the audit records; the caller's turn id when it sent one. */
  private requestId(request: Request): string {
    return request.headers.get("x-request-id") ?? crypto.randomUUID();
  }

  private invalid(message: string): Response {
    return Response.json({ error: message }, { status: MEMORY_ERROR_STATUS.validation });
  }
}

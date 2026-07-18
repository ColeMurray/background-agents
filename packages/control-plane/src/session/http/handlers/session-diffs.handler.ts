import { SessionDiffError, type SessionDiffDomainError } from "../../diffs/errors";
import type { SessionDiffService } from "../../diffs/service";

/**
 * HTTP boundary for the session diff endpoints: reads requests, delegates
 * to the domain service, and maps thrown SessionDiffError codes to
 * statuses and response bodies.
 */
export class SessionDiffsHandler {
  constructor(private readonly diffService: SessionDiffService) {}

  /** Serialize the browser-safe state returned by the authenticated manifest route. */
  state(): Response {
    return Response.json(this.diffService.getPublicState());
  }

  /** Accept a sandbox-produced bundle as the latest revision. */
  async storeBundle(request: Request): Promise<Response> {
    try {
      const revisionId = this.diffService.publishBundle(await this.readJson(request));
      return Response.json({ revisionId });
    } catch (e) {
      return this.errorResponse(e);
    }
  }

  /** Record a refresh failure reported by the sandbox. */
  async recordFailure(request: Request): Promise<Response> {
    try {
      this.diffService.recordRefreshFailure(await this.readJson(request));
      return new Response(null, { status: 204 });
    } catch (e) {
      return this.errorResponse(e);
    }
  }

  /** Serve a revision-pinned patch for a single file. */
  resolveFile(url: URL): Response {
    try {
      const patch = this.diffService.resolveFile(
        url.searchParams.get("revisionId"),
        url.searchParams.get("fileId")
      );
      return new Response(patch, {
        headers: {
          "Content-Type": "text/x-diff; charset=utf-8",
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (e) {
      return this.errorResponse(e);
    }
  }

  /** Request a non-blocking diff refresh from the session sandbox. */
  retry(): Response {
    try {
      this.diffService.requestRefresh();
      return Response.json({ accepted: true }, { status: 202 });
    } catch (e) {
      return this.errorResponse(e);
    }
  }

  private errorResponse(errorValue: unknown): Response {
    if (!(errorValue instanceof SessionDiffError)) throw errorValue;

    // SessionDiffError is abstract, so every instance is one of the
    // concrete union members and the `code` switch discriminates payloads.
    const domainError = errorValue as SessionDiffDomainError;
    switch (domainError.code) {
      case "invalid_bundle":
      case "repository_mismatch":
      case "baseline_mismatch":
      case "invalid_failure":
      case "invalid_file_identity":
        return Response.json({ error: domainError.message }, { status: 400 });
      case "baseline_unavailable":
      case "sandbox_not_connected":
        return Response.json({ error: domainError.message }, { status: 409 });
      case "diff_revision_stale":
        return Response.json(
          {
            error: domainError.message,
            code: domainError.code,
            currentRevisionId: domainError.currentRevisionId,
          },
          { status: 409 }
        );
      case "diff_file_not_found":
        return Response.json(
          {
            error: domainError.message,
            code: domainError.code,
            currentRevisionId: domainError.currentRevisionId,
          },
          { status: 404 }
        );
      default: {
        const exhaustive: never = domainError;
        return Response.json(
          { error: `Unhandled session diff error: ${String(exhaustive)}` },
          { status: 500 }
        );
      }
    }
  }

  private async readJson(request: Request): Promise<unknown> {
    try {
      return await request.json();
    } catch {
      return null;
    }
  }
}

import {
  DiffBaselineMismatchError,
  DiffBaselineUnavailableError,
  DiffFileNotFoundError,
  DiffRepositoryMismatchError,
  DiffRevisionStaleError,
  InvalidDiffBundleError,
  InvalidDiffFailureError,
  InvalidDiffFileIdentityError,
  SandboxNotConnectedError,
} from "../../diffs/errors";
import type { SessionDiffService } from "../../diffs/service";

/**
 * HTTP boundary for the session diff endpoints: reads requests, delegates
 * to the domain service, and maps thrown domain errors to statuses and
 * response bodies.
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

  /** Map each domain error to its status; anything unrecognized is rethrown. */
  private errorResponse(errorValue: unknown): Response {
    if (
      errorValue instanceof InvalidDiffBundleError ||
      errorValue instanceof DiffRepositoryMismatchError ||
      errorValue instanceof DiffBaselineMismatchError ||
      errorValue instanceof InvalidDiffFailureError ||
      errorValue instanceof InvalidDiffFileIdentityError
    ) {
      return Response.json({ error: errorValue.message }, { status: 400 });
    }
    if (
      errorValue instanceof DiffBaselineUnavailableError ||
      errorValue instanceof SandboxNotConnectedError
    ) {
      return Response.json({ error: errorValue.message }, { status: 409 });
    }
    if (errorValue instanceof DiffRevisionStaleError) {
      return Response.json(
        {
          error: errorValue.message,
          code: "diff_revision_stale",
          currentRevisionId: errorValue.currentRevisionId,
        },
        { status: 409 }
      );
    }
    if (errorValue instanceof DiffFileNotFoundError) {
      return Response.json(
        {
          error: errorValue.message,
          code: "diff_file_not_found",
          currentRevisionId: errorValue.currentRevisionId,
        },
        { status: 404 }
      );
    }
    throw errorValue;
  }

  private async readJson(request: Request): Promise<unknown> {
    try {
      return await request.json();
    } catch {
      return null;
    }
  }
}

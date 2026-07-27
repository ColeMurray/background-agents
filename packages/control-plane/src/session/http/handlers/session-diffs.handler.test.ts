import { describe, expect, it, vi } from "vitest";
import {
  DiffBaselineUnavailableError,
  DiffFileNotFoundError,
  DiffRevisionStaleError,
  InvalidDiffBundleError,
  InvalidDiffFileIdentityError,
  SandboxNotConnectedError,
} from "../../diffs/errors";
import type { SessionDiffService } from "../../diffs/service";
import { SessionDiffsHandler } from "./session-diffs.handler";

function harness(overrides: Partial<SessionDiffService> = {}) {
  const service = {
    getPublicState: vi.fn(() => ({ version: 1, current: null, lastError: null })),
    publishBundle: vi.fn(() => "revision-1"),
    recordRefreshFailure: vi.fn(),
    resolveFile: vi.fn(() => "diff --git a/src/app.ts b/src/app.ts\n"),
    requestRefresh: vi.fn(),
    ...overrides,
  } as unknown as SessionDiffService;
  return { handler: new SessionDiffsHandler(service), service };
}

const jsonRequest = (body: unknown) =>
  new Request("http://internal/diff", { method: "POST", body: JSON.stringify(body) });

describe("SessionDiffsHandler", () => {
  it("serializes the public state", async () => {
    const { handler } = harness();

    const response = handler.state();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ version: 1, current: null });
  });

  it("returns the published revision id and passes the parsed body through", async () => {
    const { handler, service } = harness();

    const response = await handler.storeBundle(jsonRequest({ triggerMessageId: "m-1" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ revisionId: "revision-1" });
    expect(service.publishBundle).toHaveBeenCalledWith({ triggerMessageId: "m-1" });
  });

  it("passes null through when the request body is not JSON", async () => {
    const { handler, service } = harness({
      publishBundle: vi.fn(() => {
        throw new InvalidDiffBundleError();
      }),
    });

    const response = await handler.storeBundle(
      new Request("http://internal/diff", { method: "POST", body: "not json" })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid session diff bundle" });
    expect(service.publishBundle).toHaveBeenCalledWith(null);
  });

  it("maps baseline_unavailable to a conflict", async () => {
    const { handler } = harness({
      publishBundle: vi.fn(() => {
        throw new DiffBaselineUnavailableError();
      }),
    });

    const response = await handler.storeBundle(jsonRequest({}));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Session start baseline is unavailable",
    });
  });

  it("records a failure with no content", async () => {
    const { handler, service } = harness();

    const response = await handler.recordFailure(jsonRequest({ error: "collector timed out" }));

    expect(response.status).toBe(204);
    expect(service.recordRefreshFailure).toHaveBeenCalledWith({ error: "collector timed out" });
  });

  it("serves a resolved patch with diff headers", () => {
    const { handler, service } = harness();

    const response = handler.resolveFile(
      new URL("http://internal/file?revisionId=revision-1&fileId=file-1")
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/x-diff; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(service.resolveFile).toHaveBeenCalledWith("revision-1", "file-1");
  });

  it("maps file resolution errors onto stable status codes and payloads", async () => {
    const cases = [
      {
        error: new InvalidDiffFileIdentityError(),
        status: 400,
        body: { error: "Invalid diff file identity" },
      },
      {
        error: new DiffRevisionStaleError("revision-2"),
        status: 409,
        body: {
          error: "Diff revision is stale",
          code: "diff_revision_stale",
          currentRevisionId: "revision-2",
        },
      },
      {
        error: new DiffFileNotFoundError("revision-2"),
        status: 404,
        body: {
          error: "Diff file not found",
          code: "diff_file_not_found",
          currentRevisionId: "revision-2",
        },
      },
    ];

    for (const { error, status, body } of cases) {
      const { handler } = harness({
        resolveFile: vi.fn(() => {
          throw error;
        }),
      });

      const response = handler.resolveFile(new URL("http://internal/file?revisionId=r&fileId=f"));

      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toEqual(body);
    }
  });

  it("accepts retry and reports a disconnected sandbox as a conflict", async () => {
    const { handler } = harness();
    expect(handler.retry().status).toBe(202);

    const disconnected = harness({
      requestRefresh: vi.fn(() => {
        throw new SandboxNotConnectedError();
      }),
    });
    const response = disconnected.handler.retry();
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "Sandbox is not connected" });
  });

  it("rethrows errors that are not session diff errors", () => {
    const { handler } = harness({
      requestRefresh: vi.fn(() => {
        throw new TypeError("unexpected");
      }),
    });

    expect(() => handler.retry()).toThrow(TypeError);
  });
});

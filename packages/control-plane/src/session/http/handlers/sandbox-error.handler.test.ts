import { describe, expect, it, vi } from "vitest";
import type { SandboxRow } from "../../types";
import { createHandler } from "./sandbox.handler.test-helpers";

describe("SandboxHandler.sandboxError", () => {
  it("authenticates the current sandbox generation and coordinates a fatal runtime error", async () => {
    const { handler, getSandbox, isValidSandboxToken, failSandbox } = createHandler();
    const sandbox = {
      id: "sandbox-row-1",
      modal_sandbox_id: "sandbox-1",
      auth_token_hash: "token-hash-1",
      auth_token: null,
    } as SandboxRow;
    getSandbox.mockReturnValue(sandbox);
    isValidSandboxToken.mockResolvedValue(true);

    const response = await handler.sandboxError(
      new Request("http://internal/internal/sandbox-error", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer sandbox-token",
          "X-Sandbox-ID": "sandbox-1",
        },
        body: JSON.stringify({ error: "OpenCode repeatedly crashed", fatal: true }),
      })
    );

    expect(response.status).toBe(200);
    expect(isValidSandboxToken).toHaveBeenCalledWith("sandbox-token", sandbox);
    expect(failSandbox).toHaveBeenCalledWith("OpenCode repeatedly crashed");
  });

  it("strips a legacy output tail before landing a fatal report as the failed phase", async () => {
    const { handler, getSandbox, isValidSandboxToken, failSandbox, processSandboxEvent } =
      createHandler();
    getSandbox.mockReturnValue({
      id: "sandbox-row-1",
      modal_sandbox_id: "sandbox-1",
      auth_token_hash: "token-hash-1",
      auth_token: null,
      status: "connecting",
    } as SandboxRow);
    isValidSandboxToken.mockResolvedValue(true);
    const order: string[] = [];
    processSandboxEvent.mockImplementation(async () => {
      order.push("phase");
    });
    failSandbox.mockImplementation(async () => {
      order.push("fail");
    });

    const response = await handler.sandboxError(
      new Request("http://internal/internal/sandbox-error", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer sandbox-token",
          "X-Sandbox-ID": "sandbox-1",
        },
        body: JSON.stringify({
          error: "start.sh exited 1",
          fatal: true,
          phase: "start",
          bootSeq: 7,
          repoOwner: "acme",
          repoName: "api",
          outputTail: ["npm ERR! missing script: start"],
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(processSandboxEvent).toHaveBeenCalledWith({
      type: "boot_progress",
      phase: "start",
      status: "failed",
      bootSeq: 7,
      repoOwner: "acme",
      repoName: "api",
      detail: "start.sh exited 1",
      sandboxId: "sandbox-1",
      timestamp: 1.234,
    });
    expect(order).toEqual(["phase", "fail"]);
    expect(failSandbox).toHaveBeenCalledWith("start.sh exited 1");
  });

  it("accepts a fatal report without phase fields from an older runtime", async () => {
    const { handler, getSandbox, isValidSandboxToken, failSandbox, processSandboxEvent } =
      createHandler();
    getSandbox.mockReturnValue({
      id: "sandbox-row-1",
      modal_sandbox_id: "sandbox-1",
      auth_token_hash: "token-hash-1",
      auth_token: null,
      status: "connecting",
    } as SandboxRow);
    isValidSandboxToken.mockResolvedValue(true);

    const response = await handler.sandboxError(
      new Request("http://internal/internal/sandbox-error", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer sandbox-token",
          "X-Sandbox-ID": "sandbox-1",
        },
        body: JSON.stringify({ error: "OpenCode repeatedly crashed" }),
      })
    );

    expect(response.status).toBe(200);
    expect(processSandboxEvent).not.toHaveBeenCalled();
    expect(failSandbox).toHaveBeenCalledWith("OpenCode repeatedly crashed");
  });

  it("rejects an empty sandbox error", async () => {
    const { handler, getSandbox, isValidSandboxToken, failSandbox } = createHandler();
    getSandbox.mockReturnValue({
      id: "sandbox-row-1",
      modal_sandbox_id: "sandbox-1",
      auth_token_hash: "token-hash-1",
      auth_token: null,
    } as SandboxRow);
    isValidSandboxToken.mockResolvedValue(true);

    const response = await handler.sandboxError(
      new Request("http://internal/internal/sandbox-error", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer sandbox-token",
          "X-Sandbox-ID": "sandbox-1",
        },
        body: JSON.stringify({ error: "" }),
      })
    );

    expect(response.status).toBe(400);
    expect(failSandbox).not.toHaveBeenCalled();
  });

  it("authenticates before parsing the sandbox error body", async () => {
    const { handler, failSandbox } = createHandler();
    const response = await handler.sandboxError(
      new Request("http://internal/internal/sandbox-error", {
        method: "POST",
        body: "not json",
      })
    );

    expect(response.status).toBe(401);
    expect(failSandbox).not.toHaveBeenCalled();
  });

  it.each(
    (["stopped", "stale", "failed"] as const).flatMap((status) => [
      [status, status],
      [status, "ready"],
    ])
  )(
    "does not overwrite a %s sandbox with a delayed fatal report (initially %s)",
    async (status, initialStatus) => {
      const { handler, getSandbox, isValidSandboxToken, failSandbox, log } = createHandler();
      const sandbox = {
        id: "sandbox-row-1",
        modal_sandbox_id: "sandbox-1",
        auth_token_hash: "token-hash-1",
        auth_token: null,
        status: initialStatus,
      } as SandboxRow;
      getSandbox.mockReturnValue(sandbox);
      isValidSandboxToken.mockImplementation(async () => {
        getSandbox.mockReturnValue({ ...sandbox, status } as SandboxRow);
        return true;
      });

      const response = await handler.sandboxError(
        new Request("http://internal/internal/sandbox-error", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Authorization: "Bearer sandbox-token",
            "X-Sandbox-ID": "sandbox-1",
          },
          body: JSON.stringify({ error: "Delayed failure" }),
        })
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ status: "ignored" });
      expect(failSandbox).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(
        "Ignoring fatal report from a sandbox that is no longer live",
        {
          event: "sandbox.error_ignored",
          sandbox_status: status,
          sandbox_status_at_report: initialStatus,
          error: "Delayed failure",
        }
      );
    }
  );

  it.each(
    (["failed", "stopped", "stale"] as const).flatMap((initialStatus) =>
      ["authentication", "body parsing"].map((suspendedAt) => ({ initialStatus, suspendedAt }))
    )
  )(
    "handles a fatal report from a $initialStatus sandbox that reconnects during $suspendedAt",
    async ({ initialStatus, suspendedAt }) => {
      const { handler, getSandbox, isValidSandboxToken, failSandbox } = createHandler();
      const credentials = {
        id: "sandbox-row-1",
        modal_sandbox_id: "sandbox-1",
        auth_token_hash: "token-hash-1",
        auth_token: null,
      };
      const sandbox = { ...credentials, status: initialStatus, created_at: 1000 } as SandboxRow;
      getSandbox.mockReturnValue(sandbox);
      isValidSandboxToken.mockResolvedValue(true);
      const report = { error: "OpenCode crashed repeatedly, giving up", fatal: true };
      const request = new Request("http://internal/internal/sandbox-error", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer sandbox-token",
          "X-Sandbox-ID": "sandbox-1",
        },
        body: JSON.stringify(report),
      });
      const reconnect = () => {
        // A failed bridge reconnects in the same generation; a resume starts a new one.
        getSandbox.mockReturnValue({
          ...sandbox,
          status: "ready",
          created_at: initialStatus === "failed" ? sandbox.created_at : sandbox.created_at + 1,
        } as SandboxRow);
      };
      if (suspendedAt === "authentication") {
        isValidSandboxToken.mockImplementation(async () => {
          reconnect();
          return true;
        });
      } else {
        vi.spyOn(request, "json").mockImplementation(async () => {
          reconnect();
          return report;
        });
      }

      const response = await handler.sandboxError(request);

      expect(response.status).toBe(200);
      const shouldFail = initialStatus === "failed";
      await expect(response.json()).resolves.toEqual({ status: shouldFail ? "ok" : "ignored" });
      expect(isValidSandboxToken).toHaveBeenCalledWith("sandbox-token", sandbox);
      if (shouldFail) {
        expect(failSandbox).toHaveBeenCalledExactlyOnceWith(report.error);
      } else {
        expect(failSandbox).not.toHaveBeenCalled();
      }
    }
  );

  it.each(
    [
      {
        change: "credentials",
        replacement: { modal_sandbox_id: "sandbox-2", auth_token_hash: "token-hash-2" },
      },
      { change: "resume timestamp", replacement: { created_at: 2000 } },
    ].flatMap((replacement) =>
      ["authentication", "body parsing"].map((suspendedAt) => ({ ...replacement, suspendedAt }))
    )
  )(
    "rejects a generation with changed $change during $suspendedAt",
    async ({ replacement, suspendedAt }) => {
      const { handler, getSandbox, isValidSandboxToken, failSandbox } = createHandler();
      const originalSandbox = {
        id: "sandbox-row-1",
        modal_sandbox_id: "sandbox-1",
        auth_token_hash: "token-hash-1",
        auth_token: null,
        status: "ready",
        created_at: 1000,
      } as SandboxRow;
      getSandbox.mockReturnValue(originalSandbox);
      isValidSandboxToken.mockResolvedValue(true);
      const report = { error: "Old sandbox failed" };
      const request = new Request("http://internal/internal/sandbox-error", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer old-token",
          "X-Sandbox-ID": "sandbox-1",
        },
        body: JSON.stringify(report),
      });
      const replace = () => {
        getSandbox.mockReturnValue({ ...originalSandbox, ...replacement, status: "connecting" });
      };
      if (suspendedAt === "authentication") {
        isValidSandboxToken.mockImplementation(async () => {
          replace();
          return true;
        });
      } else {
        vi.spyOn(request, "json").mockImplementation(async () => {
          replace();
          return report;
        });
      }

      const response = await handler.sandboxError(request);

      expect(response.status).toBe(403);
      expect(failSandbox).not.toHaveBeenCalled();
    }
  );
});

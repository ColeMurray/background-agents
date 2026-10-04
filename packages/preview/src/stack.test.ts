import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startPreviewStack } from "./stack";
import type * as BackendModule from "./backend";
import type * as FsPromises from "node:fs/promises";
import { waitFor } from "./process";
import { PERSONAS } from "./ready";

const { startBackend, removalFailure } = vi.hoisted(() => ({
  startBackend: vi.fn(),
  removalFailure: { path: "" },
}));
vi.mock("./backend", async (original) => ({
  ...(await original<typeof BackendModule>()),
  startPreviewBackend: startBackend,
}));
// Fails one path's removal as a permission error would; root would ignore real permissions.
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof FsPromises>();
  return {
    ...fs,
    rm: async (path: string, options?: Parameters<typeof fs.rm>[1]) => {
      if (path === removalFailure.path)
        throw Object.assign(new Error(`EACCES: permission denied, rm '${path}'`), {
          code: "EACCES",
        });
      return fs.rm(path, options);
    },
  };
});

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "oi-preview-stack-test-"));
  startBackend.mockReset();
});
afterEach(async () => {
  removalFailure.path = "";
  await rm(root, { recursive: true, force: true });
});

/** A checkout whose `next` binary is one of this suite's stand-in web servers. */
async function withNextStandIn(fixture: "serving-next.mjs" | "stalled-next.mjs") {
  await mkdir(join(root, "packages/web"), { recursive: true });
  await mkdir(join(root, "node_modules/next/dist/bin"), { recursive: true });
  await symlink(
    join(import.meta.dirname, "fixtures", fixture),
    join(root, "node_modules/next/dist/bin/next")
  );
}

const member = { userId: "test-member", cookieHeader: "session=private-cookie" };

describe("checkout ownership", () => {
  const lockPath = () => join(root, ".preview/lock.json");

  it("never takes over a lock it cannot read or whose process still runs", async () => {
    await mkdir(join(root, ".preview"));
    for (const content of ["other owner", JSON.stringify({ pid: process.pid })]) {
      await writeFile(lockPath(), content);
      await expect(startPreviewStack({ root })).rejects.toThrow("checkout already owned");
      expect(await readFile(lockPath(), "utf8")).toBe(content);
    }
    expect(startBackend).not.toHaveBeenCalled();
  });

  it("takes over the lock of a preview that was killed, and releases it again", async () => {
    await mkdir(join(root, ".preview"));
    const { pid } = spawnSync(process.execPath, ["-e", ""]);
    await writeFile(lockPath(), JSON.stringify({ pid }));
    startBackend.mockRejectedValue(new Error("control-plane: stop after preflight"));
    await expect(startPreviewStack({ root })).rejects.toThrow("stop after preflight");
    await expect(stat(lockPath())).rejects.toMatchObject({ code: "ENOENT" });
  });
});

it("retains sanitized startup and cleanup evidence while releasing acquired resources", async () => {
  let runDir = "";
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let closed: Promise<void> | undefined;
  startBackend.mockImplementation(async (options: { runDir: string }) => {
    runDir = options.runDir;
    return {
      config: { BROWSER_AUTH_SECRET: "private-auth-secret" },
      identities: { member },
      close: () =>
        (closed ??= (async () => {
          await new Promise<void>((resolve) => server.close(() => resolve()));
          throw new Error("fixture: GET https://api.github.com/unsupported");
        })()),
    };
  });
  try {
    await expect(
      startPreviewStack({
        root,
        onStage(stage) {
          if (stage !== "web") return;
          writeFileSync(
            join(runDir, "web.log"),
            "Compilation failed: private-auth-secret session=private-cookie private-cookie"
          );
          throw new Error("web: primary compile failure");
        },
      })
    ).rejects.toThrow("sanitized diagnostic");
    const diagnosticPath = join(root, ".preview/last-failure.log");
    const diagnostic = await readFile(diagnosticPath, "utf8");
    expect(diagnostic).toContain("primary compile failure");
    expect(diagnostic).toContain("Compilation failed");
    expect(diagnostic).toContain("GET https://api.github.com/unsupported");
    expect(diagnostic).not.toContain("private-auth-secret");
    expect(diagnostic).not.toContain("private-cookie");
    expect((await stat(diagnosticPath)).mode & 0o777).toBe(0o600);
    await expect(stat(runDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(root, ".preview/lock.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fetch(origin)).rejects.toThrow();
  } finally {
    server.close();
  }
});

it("releases the checkout lock even when removing the run directory fails", async () => {
  let runDir = "";
  startBackend.mockImplementation(async (options: { runDir: string }) => {
    runDir = options.runDir;
    return { config: {}, identities: { member }, close: async () => {} };
  });
  try {
    await expect(
      startPreviewStack({
        root,
        onStage(stage) {
          if (stage !== "web") return;
          removalFailure.path = runDir;
          throw new Error("web: primary compile failure");
        },
      })
    ).rejects.toThrow("sanitized diagnostic");
    await expect(stat(join(root, ".preview/lock.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const diagnostic = await readFile(join(root, ".preview/last-failure.log"), "utf8");
    expect(diagnostic).toContain("primary compile failure");
    expect(diagnostic).toContain("EACCES");
  } finally {
    removalFailure.path = "";
    if (runDir) await rm(runDir, { recursive: true, force: true });
  }
});

it.each(["cancellation", "timeout"])(
  "releases a stalled startup's child, backend and files on %s",
  async (reason) => {
    const controller = new AbortController();
    let runDir = "";
    let webOrigin = "";
    let backendClosed = false;
    let childPid: number | undefined;
    let startupFinished = false;
    let stopped: Promise<Error> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await withNextStandIn("stalled-next.mjs");
      startBackend.mockImplementation(async (options: { runDir: string; webOrigin: string }) => {
        runDir = options.runDir;
        webOrigin = options.webOrigin;
        return {
          config: { WORKER_URL: "http://127.0.0.1:1", SERVICE_AUTH_SECRET_WEB: "private-key" },
          identities: { member },
          close: async () => {
            backendClosed = true;
          },
        };
      });
      const starting = startPreviewStack({ root, signal: controller.signal });
      // Attach immediately so an early startup rejection is never unhandled.
      stopped = starting
        .then(
          () => new Error("Unexpected successful startup"),
          (error) => (error instanceof Error ? error : new Error(String(error)))
        )
        .finally(() => {
          startupFinished = true;
        });
      await waitFor("stalled post-readiness BFF call", async () => {
        const log = runDir ? await readFile(join(runDir, "web.log"), "utf8").catch(() => "") : "";
        const pid = log.match(/owned-child (\d+)/)?.[1];
        if (pid) childPid = Number(pid);
        return log.includes("stalled /api/me/authorization");
      });
      if (reason === "cancellation") controller.abort(new Error("test requested stop"));
      const error = await Promise.race([
        stopped,
        new Promise<Error>((resolve) => {
          deadline = setTimeout(
            () => resolve(new Error("Startup never stopped")),
            reason === "cancellation" ? 3000 : 15_000
          );
        }),
      ]);
      expect(error.message).toContain(
        reason === "cancellation" ? "test requested stop" : "timeout"
      );
      expect(backendClosed).toBe(true);
      expect(() => process.kill(childPid!, 0)).toThrow();
      await expect(fetch(webOrigin)).rejects.toThrow();
      await expect(stat(runDir)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(join(root, ".preview/lock.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      controller.abort();
      clearTimeout(deadline);
      // Even a broken cancellation path must not leak the child this test created.
      if (!startupFinished && childPid) process.kill(childPid, "SIGTERM");
      await stopped;
    }
  },
  25_000
);

it("reports Next exiting at once, and never the intentional close", async () => {
  // The monitor never ticks here, so only the exit report itself can settle a failure.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    await withNextStandIn("serving-next.mjs");
    const identity = { ...member, expiresAtMs: Date.now() + 60_000 };
    startBackend.mockImplementation(async () => ({
      origin: "http://127.0.0.1:1",
      config: { WORKER_URL: "http://127.0.0.1:1", SERVICE_AUTH_SECRET_WEB: "private-key" },
      identities: Object.fromEntries(PERSONAS.map((persona) => [persona, identity])),
      aliases: {},
      modal: { origin: "http://127.0.0.1:2" },
      signIn: async () => {
        throw new Error("not signed in by this test");
      },
      failures: () => [],
      close: async () => {},
    }));

    const closed = await startPreviewStack({ root, scenario: "empty" });
    let closeFailure: Error | undefined;
    void closed.failure.then((error) => {
      closeFailure = error;
    });
    await closed.close();
    await new Promise((resolve) => setImmediate(resolve));
    expect(closeFailure).toBeUndefined();

    const crashed = await startPreviewStack({ root, scenario: "empty" });
    try {
      const pid = await waitFor("web child PID", async () => {
        const log = await readFile(crashed.ready.logs.web, "utf8").catch(() => "");
        return Number(log.match(/owned-child (\d+)/)?.[1]) || false;
      });
      process.kill(pid, "SIGKILL");
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const failure = await Promise.race([
        crashed.failure,
        new Promise<Error>((resolve) => {
          deadline = setTimeout(() => resolve(new Error("Next's exit was never reported")), 10_000);
        }),
      ]);
      clearTimeout(deadline);
      expect(failure.message).toContain("web: Next exited (SIGKILL)");
    } finally {
      await crashed.close();
    }
  } finally {
    vi.useRealTimers();
  }
}, 30_000);

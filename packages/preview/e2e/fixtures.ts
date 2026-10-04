import { test as base, expect, type BrowserContext } from "@playwright/test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Persona, PreviewReady } from "../src/ready";

const LAUNCHER = fileURLToPath(new URL("../bin/preview.mjs", import.meta.url));
const READY_TIMEOUT_MS = 180_000;

type Exit = { code: number | null; signal: NodeJS.Signals | null };

/** The real launcher, run the way a person runs it, and driven through what it prints. */
export interface Preview {
  ready: PreviewReady;
  /** Everything the launcher has printed to stdout. */
  stdout(): string;
  /** Presses Ctrl-C twice, the second while cleanup runs, and waits for the launcher to exit. */
  interrupt(): Promise<Exit>;
  /** Signs a browser context in as a persona through its sign-in link. */
  signIn(context: BrowserContext, persona: Persona): Promise<void>;
  modal: {
    hold(): Promise<void>;
    release(): Promise<void>;
    promptsReceived(): Promise<Array<{ messageId: string; content: string }>>;
  };
}

// The launcher exits non-zero on any failure while it runs (Next exiting, an unexpected upstream
// request, a fake Modal error), so its clean exit at the end judges the whole run.
export const test = base.extend<object, { preview: Preview }>({
  preview: [
    // Playwright requires a destructured first argument; this fixture needs no other fixture.
    async ({ browserName: _browserName }, provide) => {
      // A process group of its own, so the suite can signal all of it the way a terminal does.
      const launcher = spawn(
        process.execPath,
        [LAUNCHER, "--scenario", "empty", "--browser", "none"],
        { detached: true, stdio: ["ignore", "pipe", "pipe"] }
      );
      let stdout = "";
      let stderr = "";
      launcher.stdout!.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      launcher.stderr!.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      const exited = new Promise<Exit>((resolve) =>
        launcher.once("exit", (code, signal) => resolve({ code, signal }))
      );
      const running = () => launcher.exitCode === null && launcher.signalCode === null;
      let interrupted: Promise<Exit> | undefined;
      const interrupt = () =>
        (interrupted ??= (async () => {
          process.kill(-launcher.pid!, "SIGINT");
          await new Promise((resolve) => setTimeout(resolve, 100));
          // A group that has already gone is judged by the exit, not by this send.
          if (running()) process.kill(-launcher.pid!, "SIGINT");
          return exited;
        })());
      try {
        await expect
          .poll(() => stdout.includes('{"status":"ready"') || !running(), {
            timeout: READY_TIMEOUT_MS,
          })
          .toBe(true);
        if (!running()) throw new Error(`The launcher exited before it was ready:\n${stderr}`);
        const ready = JSON.parse(
          stdout.split("\n").find((line) => line.startsWith('{"status":"ready"'))!
        ) as PreviewReady;
        const modal = async (path: string, init?: RequestInit) => {
          const response = await fetch(`${ready.modalOrigin}/__smoke/${path}`, init);
          expect(response.ok, `fake Modal ${path}`).toBe(true);
          return response;
        };
        await provide({
          ready,
          stdout: () => stdout,
          interrupt,
          async signIn(context, persona) {
            const response = await context.request.get(ready.signInLinks[persona], {
              maxRedirects: 0,
            });
            expect(response.status(), `sign in as ${persona}`).toBe(302);
          },
          modal: {
            hold: async () => void (await modal("hold", { method: "POST" })),
            release: async () => void (await modal("release", { method: "POST" })),
            promptsReceived: async () => (await (await modal("state")).json()).promptsReceived,
          },
        });
        if (running()) expect(await interrupt(), stderr).toEqual({ code: 0, signal: null });
      } finally {
        // Never leak the launcher group, even when an assertion above failed.
        if (running()) process.kill(-launcher.pid!, "SIGKILL");
      }
    },
    { scope: "worker", timeout: READY_TIMEOUT_MS + 60_000 },
  ],
  context: async ({ context, preview }, use) => {
    await preview.signIn(context, "member");
    await use(context);
  },
});
export { expect };

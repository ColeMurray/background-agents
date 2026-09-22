import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openPersona, closeBrowsers } from "./browser";
import type * as ChildProcessModule from "node:child_process";
import { PERSONAS, type PreviewManifest } from "./contracts";

const { exec } = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof ChildProcessModule>()),
  execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: exec }),
}));

let directory: string;
let manifestPath: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "oi-preview-browser-test-"));
  manifestPath = join(directory, "run.json");
  const manifest: PreviewManifest = {
    schemaVersion: 1,
    runId: "test",
    pid: process.pid,
    root: resolve(import.meta.dirname, "../../../.."),
    sourceRevision: "test",
    dirty: false,
    scenario: "empty",
    fixtureSchemaVersion: 1,
    webOrigin: "http://127.0.0.1:3100",
    controlPlaneOrigin: "http://127.0.0.1:3200",
    startedAtMs: Date.now(),
    expiresAtMs: Date.now() + 60_000,
    aliases: {},
    logs: { web: join(directory, "web.log") },
    checks: [],
    status: "ready",
    timings: { backendMs: 0, webReadyMs: 0, totalMs: 0 },
    personas: Object.fromEntries(
      PERSONAS.map((persona) => [
        persona,
        {
          userId: `user-${persona}`,
          statePath: join(directory, `${persona}.json`),
          browserSession: `oi-preview-test-${persona}`,
          expiresAtMs: Date.now() + 60_000,
        },
      ])
    ) as PreviewManifest["personas"],
  };
  await writeFile(manifestPath, JSON.stringify(manifest));
  exec.mockReset().mockImplementation(async (_file: string, args: string[]) => ({
    stdout: args.includes("--version")
      ? "agent-browser 0.37.0"
      : args.includes("eval")
        ? JSON.stringify({ success: true, data: { result: "user-member" } })
        : "Opened",
  }));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it.each(["launch", "identity"])(
  "never treats a failed %s handoff as imported on retry",
  async (failure) => {
    exec.mockImplementation(async (_file: string, args: string[]) => {
      if (args.includes("--version")) return { stdout: "agent-browser 0.37.0" };
      if (failure === "launch") throw new Error("browser launch failed");
      return { stdout: JSON.stringify({ success: true, data: { result: null } }) };
    });
    await expect(openPersona(manifestPath, "member")).rejects.toThrow();
    expect(JSON.parse(await readFile(join(directory, "browser-member.json"), "utf8")).status).toBe(
      "pending"
    );
    exec.mockClear();
    await expect(openPersona(manifestPath, "member")).rejects.toThrow("stop and restart");
    expect(exec.mock.calls).toHaveLength(1); // Version check only; no second state import or false success.
  }
);

it("imports once, leaves logout intact on reopen, and closes only owned contexts", async () => {
  expect(await openPersona(manifestPath, "member")).toEqual({
    session: "oi-preview-test-member",
    imported: true,
  });
  expect(exec.mock.calls.some(([, args]) => args.includes("--state"))).toBe(true);
  exec.mockClear();
  // A logged-out context must not have state reimported or be forced back to its original identity.
  expect(await openPersona(manifestPath, "member")).toEqual({
    session: "oi-preview-test-member",
    imported: false,
  });
  expect(
    exec.mock.calls.some(([, args]) => args.includes("--state") || args.includes("eval"))
  ).toBe(false);
  exec.mockClear();
  await closeBrowsers(manifestPath);
  expect(exec.mock.calls).toHaveLength(1);
  expect(exec.mock.calls[0][1]).toEqual(
    expect.arrayContaining(["--session", "oi-preview-test-member", "close"])
  );
});

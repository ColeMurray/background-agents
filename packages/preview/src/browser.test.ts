import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { browserPreflight, closeAgentBrowser, openAgentBrowser } from "./browser";
import type * as ChildProcessModule from "node:child_process";

const { exec } = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof ChildProcessModule>()),
  execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: exec }),
}));

const root = resolve(import.meta.dirname, "../../..");
let runDir: string;
beforeEach(async () => {
  runDir = await mkdtemp(join(tmpdir(), "oi-preview-browser-test-"));
  exec.mockReset().mockResolvedValue({ stdout: "" });
});
afterEach(async () => {
  await rm(runDir, { recursive: true, force: true });
});

it("requires the agent-browser version the sandbox images pin", async () => {
  const pin = JSON.parse(
    await readFile(join(root, "packages/sandbox-images/toolchain.json"), "utf8")
  ).agentBrowser;
  exec.mockResolvedValue({ stdout: `agent-browser ${pin}\n` });
  await expect(browserPreflight(root)).resolves.toBeUndefined();
  exec.mockResolvedValue({ stdout: "agent-browser 0.0.1\n" });
  await expect(browserPreflight(root)).rejects.toThrow(`agent-browser ${pin} required`);
  exec.mockRejectedValue(new Error("ENOENT"));
  await expect(browserPreflight(root)).rejects.toThrow("or use --browser none");
});

it("opens and closes only its named session, isolated from the user's configuration", async () => {
  await openAgentBrowser(runDir, "oi-preview-test-member", "http://127.0.0.1:4100/as/member?k=key");
  await closeAgentBrowser(runDir, "oi-preview-test-member");
  const configPath = join(runDir, "agent-browser.json");
  expect(exec.mock.calls.map(([file, args]) => [file, args])).toEqual([
    [
      "agent-browser",
      [
        "--config",
        configPath,
        "--session",
        "oi-preview-test-member",
        "open",
        "http://127.0.0.1:4100/as/member?k=key",
      ],
    ],
    ["agent-browser", ["--config", configPath, "--session", "oi-preview-test-member", "close"]],
  ]);
  expect(await readFile(configPath, "utf8")).toBe("{}");
  expect(exec.mock.calls[0][2].cwd).toBe(runDir);
});

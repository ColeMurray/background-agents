import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { toolEnvironment } from "./config";

const exec = promisify(execFile);
const BROWSER_COMMAND_TIMEOUT_MS = 60_000;

function browserEnv() {
  return {
    ...toolEnvironment(process.env),
    ...(process.env.AGENT_BROWSER_EXECUTABLE_PATH
      ? { AGENT_BROWSER_EXECUTABLE_PATH: process.env.AGENT_BROWSER_EXECUTABLE_PATH }
      : {}),
  };
}

/** The agent-browser version the sandbox images pin, so local runs match agents' runs. */
export async function browserPreflight(root: string): Promise<void> {
  const pin = JSON.parse(
    await readFile(join(root, "packages/sandbox-images/toolchain.json"), "utf8")
  ).agentBrowser as string;
  let version: string;
  try {
    version = (await exec("agent-browser", ["--version"], { env: browserEnv() })).stdout;
  } catch {
    throw new Error(
      `preflight: install agent-browser@${pin} and Chrome, or use --browser none; the preview does not install tools automatically.`
    );
  }
  if (!version.includes(` ${pin}`))
    throw new Error(`preflight: agent-browser ${pin} required, found ${version.trim()}`);
}

async function command(runDir: string, session: string, args: string[]): Promise<void> {
  // An empty configuration keeps a user's or project's agent-browser.json out of the run.
  const configPath = join(runDir, "agent-browser.json");
  await writeFile(configPath, "{}", { mode: 0o600 });
  await exec("agent-browser", ["--config", configPath, "--session", session, ...args], {
    env: browserEnv(),
    cwd: runDir,
    timeout: BROWSER_COMMAND_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
}

/** Opens a named agent-browser session at a sign-in link, which signs it in as that persona. */
export function openAgentBrowser(runDir: string, session: string, signInLink: string) {
  return command(runDir, session, ["open", signInLink]);
}

export function closeAgentBrowser(runDir: string, session: string) {
  return command(runDir, session, ["close"]);
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { open, readdir, readFile, writeFile } from "node:fs/promises";
import { toolEnvironment } from "./config";
import { PERSONAS, type Persona } from "./personas";
import type { PreviewManifest } from "./contracts";

const exec = promisify(execFile);
function browserEnv() {
  return {
    ...toolEnvironment(process.env),
    ...(process.env.AGENT_BROWSER_EXECUTABLE_PATH
      ? { AGENT_BROWSER_EXECUTABLE_PATH: process.env.AGENT_BROWSER_EXECUTABLE_PATH }
      : {}),
  };
}
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

async function command(manifestPath: string, session: string, args: string[]): Promise<string> {
  const configPath = join(dirname(manifestPath), "agent-browser.json");
  await writeFile(configPath, "{}", { mode: 0o600 });
  const result = await exec(
    "agent-browser",
    ["--config", configPath, "--session", session, ...args],
    {
      env: browserEnv(),
      cwd: dirname(manifestPath),
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    }
  );
  return result.stdout;
}

export async function openPersona(
  manifestPath: string,
  persona: Persona
): Promise<{ session: string; imported: boolean }> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as PreviewManifest;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.expiresAtMs <= Date.now() ||
    !PERSONAS.includes(persona)
  )
    throw new Error("browser: invalid or expired run; start a new preview");
  process.kill(manifest.pid, 0);
  await browserPreflight(manifest.root);
  const identity = manifest.personas[persona];
  const markerPath = join(dirname(manifestPath), `browser-${persona}.json`);
  let imported = false;
  try {
    const marker = await open(markerPath, "wx", 0o600);
    await marker.writeFile(JSON.stringify({ session: identity.browserSession, status: "pending" }));
    await marker.close();
    imported = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as {
      session: string;
      status: string;
    };
    if (marker.status !== "verified" || marker.session !== identity.browserSession)
      throw new Error(
        "browser: a previous import did not finish verification; stop and restart this preview before retrying"
      );
  }
  // A marker is never erased/reimported: logout and expiry cannot be hidden by opening again.
  await command(manifestPath, identity.browserSession, [
    ...(imported ? ["--state", identity.statePath] : []),
    "open",
    manifest.webOrigin,
  ]);
  if (imported) {
    const output = await command(manifestPath, identity.browserSession, [
      "--json",
      "eval",
      "fetch('/api/auth/get-session').then(r => r.json()).then(s => s?.user?.id ?? null)",
    ]);
    const result = JSON.parse(output) as { success: boolean; data?: { result?: unknown } };
    const expected = persona === "expired" || persona === "anonymous" ? null : identity.userId;
    if (!result.success || result.data?.result !== expected)
      throw new Error("browser: imported persona did not match the real BFF identity");
    await writeFile(
      markerPath,
      JSON.stringify({ session: identity.browserSession, status: "verified" }),
      { mode: 0o600 }
    );
  }
  return { session: identity.browserSession, imported };
}

export async function closeBrowsers(manifestPath: string): Promise<void> {
  const directory = dirname(manifestPath);
  const entries = await readdir(directory);
  const errors: unknown[] = [];
  for (const persona of PERSONAS) {
    const filename = `browser-${persona}.json`;
    if (!entries.includes(filename)) continue;
    // One unreadable marker must not leave the remaining personas' contexts open.
    try {
      const { session } = JSON.parse(await readFile(join(directory, filename), "utf8")) as {
        session: string;
      };
      await command(manifestPath, session, ["close"]);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, "browser: failed to close owned contexts");
}

import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { browserPreflight, closeAgentBrowser, openAgentBrowser } from "./browser";
import { Cleanup } from "./cleanup";
import { errorSummary } from "./diagnostics";
import {
  PERSONAS,
  SCENARIOS,
  TEAMS_MODES,
  type Persona,
  type PreviewReady,
  type Scenario,
  type TeamsMode,
} from "./ready";
import { startPreviewStack, type PreviewStack } from "./stack";

const USAGE = `npm run preview -- [--scenario ${SCENARIOS.join("|")}] [--persona ${PERSONAS.join("|")}] [--browser agent-browser|none] [--teams ${TEAMS_MODES.join("|")}]
Keep the foreground process alive. Ctrl-C stops only its owned resources. Restart resets all fixtures.`;

/** Orderly cleanup has finished; abandoned application handles must not keep the process alive. */
const ABANDONED_HANDLES_GRACE_MS = 5_000;

/** The `npm run preview` entrypoint; `bin/preview.mjs` calls it from the bundle. */
export async function runCli(argv: string[], root: string): Promise<void> {
  try {
    await main(argv, root);
  } catch (error) {
    // Do not serialize arbitrary library errors (requests may contain bearer credentials).
    console.error(errorSummary(error));
    process.exitCode = 1;
  }
  setTimeout(() => {
    console.error("shutdown: abandoned handles kept the preview process alive; forcing exit");
    process.exit(1);
  }, ABANDONED_HANDLES_GRACE_MS).unref();
}

function choice<T extends string>(name: string, value: string, allowed: readonly T[]): T {
  if (!allowed.includes(value as T))
    throw new Error(`preflight: --${name} must be one of ${allowed.join(", ")}; use --help`);
  return value as T;
}

async function main(argv: string[], root: string): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      scenario: { type: "string", default: "populated" },
      persona: { type: "string", default: "member" },
      browser: { type: "string", default: "agent-browser" },
      teams: { type: "string", default: "on" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const scenario: Scenario = choice("scenario", values.scenario, SCENARIOS);
  const persona: Persona = choice("persona", values.persona, PERSONAS);
  const teamsEnforcement: TeamsMode = choice("teams", values.teams, TEAMS_MODES);
  const useAgentBrowser = choice("browser", values.browser, ["agent-browser", "none"]) !== "none";
  if (useAgentBrowser) await browserPreflight(root);

  const controller = new AbortController();
  let notifyStop!: () => void;
  const stopped = new Promise<void>((resolve) => {
    notifyStop = resolve;
  });
  const stop = () => {
    controller.abort();
    notifyStop();
  };
  // A terminal's Ctrl-C reaches this process and npm, which forwards it, and people press it again
  // while cleanup runs. Every repeat is the same stop request, so the handlers stay installed for
  // the life of the process: no signal may take Node's default exit and strand owned resources.
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const cleanup = new Cleanup();
  const errors: unknown[] = [];
  let stack: PreviewStack | undefined;
  let diagnosticPath: string | undefined;
  try {
    stack = await startPreviewStack({
      root,
      scenario,
      teamsEnforcement,
      signal: controller.signal,
      onStage: (stage) => console.log(JSON.stringify({ stage })),
    });
    const { ready, close } = stack;
    cleanup.defer(close);
    let browserSession: string | null = null;
    if (useAgentBrowser) {
      const session = `oi-preview-${randomUUID().slice(0, 8)}-${persona}`;
      cleanup.defer(() => closeAgentBrowser(ready.runDir, session));
      await openAgentBrowser(ready.runDir, session, ready.signInLinks[persona]);
      browserSession = session;
    }
    const line: PreviewReady = { status: "ready", ...ready, browserSession };
    console.log(JSON.stringify(line));
    console.error(
      [
        "Sign in from any browser on this machine until this preview stops:",
        ...PERSONAS.map((name) => `  ${name.padEnd(10)} ${ready.signInLinks[name]}`),
      ].join("\n")
    );
    const failure = await Promise.race([stack.failure, stopped]);
    if (failure) throw failure;
  } catch (error) {
    errors.push(error);
    // Cleanup below must run even if the diagnostic cannot be written.
    diagnosticPath = await stack?.recordFailure(error).catch((diagnosticError: unknown) => {
      errors.push(diagnosticError);
      return undefined;
    });
  }
  errors.push(...(await cleanup.run()));
  if (errors.length)
    throw new AggregateError(
      errors,
      diagnosticPath ? `Preview failed; sanitized diagnostic: ${diagnosticPath}` : "Preview failed"
    );
  console.log(JSON.stringify({ status: "stopped", clean: true }));
}

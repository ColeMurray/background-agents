import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { browserPreflight, closeBrowsers, openPersona } from "./browser";
import { PERSONAS, type Persona } from "./personas";
import { SCENARIOS, type Scenario } from "./scenarios";
import { startPreviewStack, type PreviewStack } from "./stack";
import { boundProcessExit } from "./process-exit";
import { errorSummary } from "./diagnostics";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    root: { type: "string" },
    scenario: { type: "string", default: "populated" },
    persona: { type: "string", default: "member" },
    browser: { type: "string", default: "agent-browser" },
    run: { type: "string" },
    help: { type: "boolean" },
  },
});
async function main() {
  if (values.help) {
    console.log(
      "npm run preview -- --scenario populated|empty --persona member|owner|viewer|suspended|expired|anonymous --browser agent-browser|none\nnpm run preview:open -- --run /absolute/path/run.json --persona viewer\nKeep the foreground process alive. Ctrl-C stops only its owned resources. Restart resets all fixtures."
    );
    return;
  }
  if (
    !PERSONAS.includes(values.persona as Persona) ||
    !SCENARIOS.includes(values.scenario as Scenario) ||
    !["agent-browser", "none"].includes(values.browser!)
  )
    throw new Error("preflight: invalid persona/scenario/browser; use --help");
  const persona = values.persona as Persona;
  if (positionals[0] === "open") {
    if (!values.run)
      throw new Error("preflight: preview:open requires --run /absolute/path/run.json");
    console.log(JSON.stringify(await openPersona(resolve(values.run), persona)));
    return;
  }
  if (positionals.length) throw new Error("preflight: unrecognized command; use --help");
  const root = resolve(values.root ?? process.cwd());
  if (values.browser === "agent-browser") await browserPreflight(root);
  const controller = new AbortController();
  let notifyStop!: () => void;
  const stopped = new Promise<void>((resolve) => {
    notifyStop = resolve;
  });
  const stop = () => {
    controller.abort();
    notifyStop();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let stack: PreviewStack | undefined;
  let diagnosticPath: string | undefined;
  const errors: unknown[] = [];
  try {
    stack = await startPreviewStack({
      root,
      scenario: values.scenario as Scenario,
      signal: controller.signal,
      onStage: (stage) => console.log(JSON.stringify({ stage })),
    });
    if (values.browser === "agent-browser") {
      await openPersona(stack.manifestPath, persona);
      stack.manifest.checks = stack.manifest.checks.filter(
        (check) => check !== "no-interactive-browser"
      );
      stack.manifest.checks.push(`agent-browser:${persona}`);
      await writeFile(stack.manifestPath, JSON.stringify(stack.manifest, null, 2), { mode: 0o600 });
    }
    console.log(
      JSON.stringify({
        status: "ready",
        url: stack.manifest.webOrigin,
        run: stack.manifestPath,
        persona,
        browser: values.browser,
        session: values.browser === "none" ? null : stack.manifest.personas[persona].browserSession,
        aliases: stack.manifest.aliases,
        signInLinks: stack.signInLinks,
        timings: stack.manifest.timings,
      })
    );
    const { signInLinks } = stack;
    console.error(
      [
        "Sign in from any browser on this machine until this preview stops:",
        ...PERSONAS.map((name) => `  ${name.padEnd(10)} ${signInLinks[name]}`),
      ].join("\n")
    );
    const failure = await Promise.race([stack.failure, stopped]);
    if (failure) throw failure;
  } catch (error) {
    errors.push(error);
    diagnosticPath = await stack?.recordFailure(error);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    try {
      if (stack) await closeBrowsers(stack.manifestPath);
    } catch (error) {
      errors.push(error);
      diagnosticPath = await stack?.recordFailure(error);
    } finally {
      try {
        await stack?.close();
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (errors.length)
    throw new AggregateError(
      errors,
      diagnosticPath ? `Preview failed; sanitized diagnostic: ${diagnosticPath}` : "Preview failed"
    );
  console.log(JSON.stringify({ status: "stopped", clean: true }));
}
main()
  .catch((error: unknown) => {
    // Do not serialize arbitrary library errors (requests may contain bearer credentials).
    console.error(errorSummary(error));
    process.exitCode = 1;
  })
  .finally(() => boundProcessExit());

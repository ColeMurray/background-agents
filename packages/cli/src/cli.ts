import { randomUUID } from "node:crypto";
import { Command, Option } from "commander";
import open from "open";
import { externalSessionListQuerySchema } from "@open-inspect/shared/types/external-session-api";
import { ApiClient, ApiError } from "./api-client.js";
import { CredentialLifecycle } from "./credential-lifecycle.js";
import {
  ConfigStore,
  defaultDeviceName,
  normalizeBaseUrl,
  validateContextName,
} from "./config-store.js";
import { CliError, withErrorContext } from "./errors.js";
import { serveMcp } from "./mcp-server.js";
import { Operations } from "./operations.js";
import { Output, type OutputFormat } from "./output.js";

interface CliDependencies {
  store?: ConfigStore;
  fetch?: typeof globalThis.fetch;
  openUrl?: (url: string) => Promise<void>;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  stdout?: (value: string) => void;
  stderr?: (value: string) => void;
}

/** Builds the CLI with injectable process boundaries for tests and embedding. */
export function createCli(dependencies: CliDependencies = {}): Command {
  const stdout = dependencies.stdout ?? ((value: string) => process.stdout.write(value));
  const store = dependencies.store ?? new ConfigStore();
  const credentialLifecycle = new CredentialLifecycle(store, dependencies.fetch);
  const outputFor = (command: Command, fallback?: OutputFormat) =>
    new Output(fallback ?? command.optsWithGlobals().output, {
      stdout: dependencies.stdout,
      stderr: dependencies.stderr,
    });
  const active = async () => store.getActiveContext();
  const operations = async () => {
    const context = await active();
    const api = new ApiClient({
      baseUrl: context.url,
      fetch: dependencies.fetch,
      authorize: () => Promise.resolve(context.credential),
    });
    return { api, operations: new Operations(api, { sleep: dependencies.sleep }) };
  };

  const program = new Command()
    .name("oi")
    .description("Open Inspect command-line client")
    .addOption(
      new Option("--output <format>", "output format")
        .choices(["text", "json", "stream-json"])
        .default("text")
    )
    .exitOverride()
    .configureOutput({ writeOut: stdout, writeErr: () => undefined });

  program
    .command("login")
    .description("Authorize this device and save the final credential")
    .requiredOption("--url <url>", "control-plane base URL")
    .option("--context <name>", "context name", "default")
    .option("--no-browser", "do not open a browser")
    .action(async (options, command) => {
      const output = outputFor(command);
      validateContextName(options.context);
      const baseUrl = normalizeBaseUrl(options.url);
      await credentialLifecycle.prepareLogin();
      const api = new ApiClient({ baseUrl, fetch: dependencies.fetch });
      const started = await api.startDeviceAuthorization(defaultDeviceName());
      const deviceSecretRef = await credentialLifecycle.stageDeviceAuthorization({
        url: baseUrl,
        contextName: options.context,
        deviceSecret: started.deviceSecret,
      });
      output.error(`Authorize code ${started.userCode} at ${started.verificationUrl}`);
      if (options.browser) {
        try {
          await (dependencies.openUrl ?? openBrowser)(
            validateHttpUrl(started.verificationUrl, "Verification URL")
          );
        } catch (cause) {
          output.error(`Could not open browser: ${errorMessage(cause)}`);
        }
      }
      const controller = signalController();
      let exchange;
      try {
        while (Date.now() < started.expiresAt) {
          exchange = await api.exchangeDeviceAuthorization(started.deviceSecret);
          if (exchange.status === "authorized") break;
          await sleep(started.pollIntervalMs, controller.signal, dependencies.sleep);
        }
      } catch (cause) {
        try {
          await credentialLifecycle.prepareLogin();
        } catch (recoveryCause) {
          throw new AggregateError(
            [cause, recoveryCause],
            "Device authorization failed and capability recovery remains pending"
          );
        }
        throw cause;
      }
      if (!exchange || exchange.status !== "authorized") {
        await credentialLifecycle.prepareLogin();
        throw new CliError("expired", "Device authorization expired");
      }
      const replacement = await credentialLifecycle.install(
        options.context,
        {
          url: baseUrl,
          credential: exchange.credential,
          credentialId: exchange.credentialId,
          expiresAt: exchange.expiresAt,
        },
        deviceSecretRef
      );
      output.result({
        context: options.context,
        url: baseUrl,
        expiresAt: exchange.expiresAt,
        credentialStore: await store.credentialStoreKind(),
        pendingRevocations: replacement.pendingRevocations,
        pendingDeviceAuthorizations: replacement.pendingDeviceAuthorizations,
      });
    });

  program
    .command("logout")
    .description("Revoke and remove the active context")
    .action(async (_options, command) => {
      const output = outputFor(command);
      const removed = await credentialLifecycle.logout();
      output.result({ loggedOut: removed.name });
    });

  const auth = program.command("auth").description("Manage authentication contexts");
  auth
    .command("status")
    .description("Show active credential status")
    .action(async (_options, command) => {
      const output = outputFor(command);
      const config = await store.read();
      if (!config.activeContext) {
        output.result({ reauthenticationRequired: true });
        return;
      }
      const context = await active();
      const { api } = await operations();
      try {
        output.result({
          context: context.name,
          url: context.url,
          reauthenticationRequired: false,
          ...(await api.me()),
        });
      } catch (cause) {
        if (!(cause instanceof ApiError) || cause.status !== 401) throw cause;
        output.result({ reauthenticationRequired: true });
      }
    });

  const context = program.command("context").description("Manage named installation contexts");
  context
    .command("use <name>")
    .description("Select an active context")
    .action(async (name, _options, command) => {
      await store.setActiveContext(name);
      outputFor(command).result({ activeContext: name });
    });
  context
    .command("list")
    .description("List saved contexts without credentials")
    .action(async (_options, command) => {
      const config = await store.read();
      outputFor(command).result({
        activeContext: config.activeContext,
        contexts: Object.entries(config.contexts).map(([name, context]) => ({
          name,
          url: context.url,
          expiresAt: context.expiresAt,
        })),
      });
    });

  const session = program.command("session").description("Manage repository-less sessions");
  session
    .command("create")
    .requiredOption("--title <title>")
    .requiredOption("--model <model>")
    .option("--reasoning <effort>")
    .option("--prompt <text>")
    .option("--idempotency-key <key>")
    .action(async (options, command) => {
      const idempotencyKey = options.idempotencyKey ?? randomUUID();
      let result;
      try {
        result = await (
          await operations()
        ).operations.createSession({
          title: options.title,
          model: options.model,
          reasoningEffort: options.reasoning,
          initialPrompt: options.prompt,
          idempotencyKey,
        });
      } catch (cause) {
        throw withErrorContext(cause, { idempotencyKey });
      }
      outputFor(command).result(options.idempotencyKey ? result : { ...result, idempotencyKey });
    });
  session
    .command("list")
    .option("--limit <count>", "maximum sessions to return", parseInteger)
    .option("--offset <count>", "zero-based continuation offset", parseInteger)
    .action(async (options, command) => {
      const query = externalSessionListQuerySchema.parse({
        limit: options.limit,
        offset: options.offset,
      });
      outputFor(command).result(await (await operations()).operations.listSessions(query));
    });
  session
    .command("get <id>")
    .action(async (id, _options, command) =>
      outputFor(command).result(await (await operations()).operations.getSession(id))
    );
  session
    .command("prompt <id>")
    .requiredOption("--content <text>")
    .option("--client-request-id <id>")
    .option("--model <model>")
    .option("--reasoning <effort>")
    .action(async (id, options, command) => {
      const clientRequestId = options.clientRequestId ?? randomUUID();
      let result;
      try {
        result = await (
          await operations()
        ).operations.promptSession(id, {
          content: options.content,
          clientRequestId,
          model: options.model,
          reasoningEffort: options.reasoning,
        });
      } catch (cause) {
        throw withErrorContext(cause, { clientRequestId });
      }
      outputFor(command).result(options.clientRequestId ? result : { ...result, clientRequestId });
    });
  session
    .command("stop <id>")
    .action(async (id, _options, command) =>
      outputFor(command).result(await (await operations()).operations.stopSession(id))
    );
  session
    .command("events <id>")
    .option("--cursor <cursor>")
    .option("--follow")
    .option("--poll-interval <ms>", "poll interval in milliseconds", parseNumber, 1_000)
    .option("--timeout <ms>", "timeout in milliseconds", parseNumber, 30 * 60_000)
    .action(async (id, options, command) => {
      const output = outputFor(command, options.follow ? "stream-json" : undefined);
      const current = (await operations()).operations;
      if (!options.follow)
        return output.result(await current.events(id, { cursor: options.cursor }));
      const controller = signalController(options.timeout);
      for await (const change of current.followEvents(id, {
        pollIntervalMs: options.pollInterval,
        timeoutMs: options.timeout,
        signal: controller.signal,
      }))
        output.result(change);
    });
  session
    .command("wait <id>")
    .option("--poll-interval <ms>", "poll interval in milliseconds", parseNumber, 1_000)
    .option("--timeout <ms>", "timeout in milliseconds", parseNumber, 30 * 60_000)
    .action(async (id, options, command) => {
      const controller = signalController(options.timeout);
      outputFor(command).result(
        await (
          await operations()
        ).operations.wait(id, {
          pollIntervalMs: options.pollInterval,
          timeoutMs: options.timeout,
          signal: controller.signal,
        })
      );
    });

  program
    .command("mcp")
    .command("serve")
    .description("Run the local stdio MCP server")
    .action(async () => {
      await serveMcp((await operations()).operations);
    });
  return program;
}

export async function runCli(
  argv = process.argv,
  dependencies: CliDependencies = {}
): Promise<void> {
  try {
    await createCli(dependencies).parseAsync(argv);
  } catch (cause) {
    new Output(outputFormatFromArgv(argv), {
      stdout: dependencies.stdout,
      stderr: dependencies.stderr,
    }).failure(cause);
    throw cause;
  }
}

function parseNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0)
    throw new Error(`Invalid nonnegative number: ${value}`);
  return parsed;
}

function parseInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error(`Invalid nonnegative integer: ${value}`);
  return parsed;
}

function signalController(timeoutMs?: number): AbortController {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort(new Error("Interrupted")));
  if (timeoutMs !== undefined)
    setTimeout(() => controller.abort(new CliError("timeout", "Timed out")), timeoutMs).unref();
  return controller;
}

function sleep(
  milliseconds: number,
  signal: AbortSignal,
  custom?: CliDependencies["sleep"]
): Promise<void> {
  if (custom) return custom(milliseconds, signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true }
    );
  });
}

function openBrowser(url: string): Promise<void> {
  return open(url, { wait: false }).then(() => undefined);
}

export function validateHttpUrl(value: string, label = "URL"): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new CliError("validation", `${label} is invalid`, undefined, undefined, { cause });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new CliError("validation", `${label} must use HTTP or HTTPS`);
  if (url.username || url.password)
    throw new CliError("validation", `${label} must not include credentials`);
  return url.toString();
}

function outputFormatFromArgv(argv: string[]): OutputFormat {
  const inline = argv.find((value) => value.startsWith("--output="))?.slice("--output=".length);
  if (inline === "json" || inline === "stream-json") return inline;
  const index = argv.findIndex((value) => value === "--output");
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value === "json" || value === "stream-json" ? value : "text";
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Browser launch failed";
}

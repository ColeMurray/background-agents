import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { Command, Option } from "commander";
import open from "open";
import {
  externalCreateSessionRequestSchema,
  externalFollowUpRequestSchema,
  externalSessionListQuerySchema,
} from "@open-inspect/shared/types/external-session-api";
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
import { validateAttachmentBytes } from "./attachments.js";
import { Operations } from "./operations.js";
import { Output, type OutputFormat } from "./output.js";

interface CliDependencies {
  store?: ConfigStore;
  fetch?: typeof globalThis.fetch;
  openUrl?: (url: string) => Promise<void>;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  stdin?: () => Promise<string>;
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
  const operations = async (clientSurface: "cli" | "mcp" = "cli") => {
    const context = await active();
    const api = new ApiClient({
      baseUrl: context.url,
      fetch: dependencies.fetch,
      authorize: () => Promise.resolve(context.credential),
      clientSurface,
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
          try {
            exchange = await api.exchangeDeviceAuthorization(started.deviceSecret);
          } catch (cause) {
            if (!isTransientLoginPollError(cause)) throw cause;
          }
          if (exchange?.status === "authorized") break;
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
      const identity = await new ApiClient({
        baseUrl,
        fetch: dependencies.fetch,
        authorize: () => Promise.resolve(exchange.credential),
      })
        .me()
        .catch(() => null);
      const credentialStore = await store.credentialStoreKind();
      output.result({
        context: options.context,
        url: baseUrl,
        expiresAt: exchange.expiresAt,
        credentialStore,
        ...(credentialStore === "file" ? { credentialFile: store.filePath } : {}),
        ...(identity ? { installation: identity.installation, user: identity.user } : {}),
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
      output.result({
        loggedOut: removed.name,
        remoteRevocationComplete: removed.remoteRevocationComplete,
        pendingRevocations: removed.pendingRevocations,
        pendingDeviceAuthorizations: removed.pendingDeviceAuthorizations,
      });
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
        output.result({
          context: context.name,
          url: context.url,
          expiresAt: context.expiresAt,
          reauthenticationRequired: true,
        });
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

  const pagedDiscovery = (
    command: Command,
    run: (query: { limit?: number; offset?: number }) => Promise<unknown>
  ) =>
    command
      .option("--limit <count>", "maximum results", parseInteger)
      .option("--offset <count>", "zero-based continuation offset", parseInteger)
      .action(async (options, current) =>
        outputFor(current).result(await run({ limit: options.limit, offset: options.offset }))
      );

  pagedDiscovery(program.command("repo").command("list"), async (query) =>
    (await operations()).operations.listRepositories(query)
  );
  const environment = program.command("environment").description("Discover saved environments");
  pagedDiscovery(environment.command("list"), async (query) =>
    (await operations()).operations.listEnvironments(query)
  );
  environment
    .command("get <id>")
    .action(async (id, _options, command) =>
      outputFor(command).result(await (await operations()).operations.getEnvironment(id))
    );
  program
    .command("model")
    .command("list")
    .action(async (_options, command) =>
      outputFor(command).result(await (await operations()).operations.listModels())
    );
  pagedDiscovery(program.command("skill").command("list"), async (query) =>
    (await operations()).operations.listSkills(query)
  );
  pagedDiscovery(program.command("provider-account").command("list"), async (query) =>
    (await operations()).operations.listProviderAccounts(query)
  );

  const session = program.command("session").description("Manage sessions");
  session
    .command("create")
    .option("--title <title>")
    .option("--model <model>")
    .option("--reasoning <effort>")
    .option("--prompt <text>")
    .option("--prompt-file <path>", "read prompt from a file or - for stdin")
    .option("--repo-owner <owner>")
    .option("--repo-name <name>")
    .option("--branch <branch>")
    .option("--repositories <json>", "ordered repository target JSON")
    .option("--environment <id>")
    .option("--skills <mode>", "managed skills mode: all or none")
    .option("--skill-profile <id>")
    .option("--provider-selections <json>")
    .option("--attach <path>", "attach an image", collect, [])
    .option("--input <path>", "complete JSON request file or - for stdin")
    .option("--idempotency-key <key>")
    .action(async (options, command) => {
      const idempotencyKey = options.idempotencyKey ?? randomUUID();
      const fileInput = options.input ? await readJsonInput(options.input, dependencies.stdin) : {};
      const prompt = options.promptFile
        ? await readTextInput(options.promptFile, dependencies.stdin)
        : options.prompt;
      const skillSelection = options.skillProfile
        ? { mode: "profile" as const, profileId: options.skillProfile }
        : options.skills
          ? { mode: options.skills }
          : undefined;
      const referencedAttachments = asAttachments(fileInput.initialAttachments);
      if (options.attach.length + referencedAttachments.length > 6) {
        throw new CliError("validation", "A prompt may include at most 6 attachments");
      }
      await validateLocalAttachmentPaths(options.attach);
      const input = externalCreateSessionRequestSchema.parse({
        ...fileInput,
        title: options.title ?? fileInput.title,
        model: options.model ?? fileInput.model,
        reasoningEffort: options.reasoning ?? fileInput.reasoningEffort,
        repoOwner: options.repoOwner ?? fileInput.repoOwner,
        repoName: options.repoName ?? fileInput.repoName,
        branch: options.branch ?? fileInput.branch,
        repositories: options.repositories
          ? JSON.parse(options.repositories)
          : fileInput.repositories,
        environmentId: options.environment ?? fileInput.environmentId,
        skillSelection: skillSelection ?? fileInput.skillSelection,
        providerSelections: options.providerSelections
          ? JSON.parse(options.providerSelections)
          : fileInput.providerSelections,
        initialPrompt: options.attach.length ? undefined : (prompt ?? fileInput.initialPrompt),
        initialAttachments: options.attach.length ? undefined : fileInput.initialAttachments,
        initialAttachmentCount:
          options.attach.length > 0
            ? options.attach.length + referencedAttachments.length
            : fileInput.initialAttachmentCount,
        idempotencyKey,
      });
      let result;
      try {
        const current = (await operations()).operations;
        result = await current.createSession(input);
        if (options.attach.length) {
          const uploadedAttachments = await uploadLocalAttachments(
            current,
            result.sessionId,
            options.attach,
            idempotencyKey
          );
          const content = prompt ?? fileInput.initialPrompt;
          const attachments = [...referencedAttachments, ...uploadedAttachments];
          if (content?.trim() || attachments.length) {
            const prompted = await current.promptSession(result.sessionId, {
              content,
              attachments,
              clientRequestId: `external-create:${idempotencyKey}`,
              model: input.model,
              reasoningEffort: input.reasoningEffort,
            });
            result = { sessionId: result.sessionId, ...prompted };
          }
        }
      } catch (cause) {
        throw withErrorContext(cause, {
          idempotencyKey,
          ...(result?.sessionId
            ? { sessionId: result.sessionId, failedStage: "attachment_or_prompt" }
            : {}),
        });
      }
      outputFor(command).result(options.idempotencyKey ? result : { ...result, idempotencyKey });
    });
  session
    .command("list")
    .option("--limit <count>", "maximum sessions to return", parseInteger)
    .option("--offset <count>", "zero-based continuation offset", parseInteger)
    .option("--status <status>")
    .option("--exclude-status <status>")
    .option("--exclude-automation-lineage")
    .option("--created-by <user-id>")
    .action(async (options, command) => {
      const query = externalSessionListQuerySchema.parse({
        limit: options.limit,
        offset: options.offset,
        status: options.status,
        excludeStatus: options.excludeStatus,
        excludeAutomationLineage: options.excludeAutomationLineage,
        createdBy: options.createdBy,
      });
      outputFor(command).result(await (await operations()).operations.listSessions(query));
    });
  session
    .command("get <id>")
    .action(async (id, _options, command) =>
      outputFor(command).result(await (await operations()).operations.getSession(id))
    );
  session
    .command("prompt <id> [prompt]")
    .option("--content <text>")
    .option("--content-file <path>", "read prompt from a file or - for stdin")
    .option("--input <path>", "complete JSON request file or - for stdin")
    .option("--attach <path>", "attach an image", collect, [])
    .option("--idempotency-key <key>")
    .option("--client-request-id <id>")
    .option("--model <model>")
    .option("--reasoning <effort>")
    .action(async (id, prompt, options, command) => {
      if (
        options.idempotencyKey &&
        options.clientRequestId &&
        options.idempotencyKey !== options.clientRequestId
      ) {
        throw new CliError(
          "validation",
          "--idempotency-key and --client-request-id must match when both are provided"
        );
      }
      const fileInput = options.input ? await readJsonInput(options.input, dependencies.stdin) : {};
      const clientRequestId =
        options.idempotencyKey ??
        options.clientRequestId ??
        fileInput.clientRequestId ??
        randomUUID();
      if (typeof clientRequestId !== "string") {
        throw new CliError("validation", "Prompt idempotency key must be a string");
      }
      let result;
      try {
        const current = (await operations()).operations;
        const referencedAttachments = asAttachments(fileInput.attachments);
        if (options.attach.length + referencedAttachments.length > 6) {
          throw new CliError("validation", "A prompt may include at most 6 attachments");
        }
        const attachments = await uploadLocalAttachments(
          current,
          id,
          options.attach,
          clientRequestId
        );
        result = await current.promptSession(
          id,
          externalFollowUpRequestSchema.parse({
            ...fileInput,
            content: options.contentFile
              ? await readTextInput(options.contentFile, dependencies.stdin)
              : (options.content ??
                (prompt === "-" ? await readTextInput("-", dependencies.stdin) : prompt) ??
                fileInput.content),
            attachments: [...referencedAttachments, ...attachments],
            clientRequestId,
            model: options.model ?? fileInput.model,
            reasoningEffort: options.reasoning ?? fileInput.reasoningEffort,
          })
        );
      } catch (cause) {
        throw withErrorContext(cause, { idempotencyKey: clientRequestId, clientRequestId });
      }
      const explicitRequestId =
        options.idempotencyKey ?? options.clientRequestId ?? fileInput.clientRequestId;
      outputFor(command).result(
        explicitRequestId ? result : { ...result, idempotencyKey: clientRequestId }
      );
    });
  session
    .command("stop <id>")
    .action(async (id, _options, command) =>
      outputFor(command).result(await (await operations()).operations.stopSession(id))
    );
  session
    .command("events <id>")
    .option("--cursor <cursor>")
    .option("--after <checkpoint>", "event checkpoint", parseInteger)
    .option("--limit <count>", "maximum changes", parseInteger)
    .option("--follow")
    .option("--poll-interval <ms>", "poll interval in milliseconds", parseNumber, 1_000)
    .option("--timeout <ms>", "timeout in milliseconds", parseNumber, 30 * 60_000)
    .action(async (id, options, command) => {
      const output = outputFor(command);
      const current = (await operations()).operations;
      if (!options.follow)
        return output.result(
          await current.events(id, {
            cursor: options.cursor,
            after: options.after,
            limit: options.limit,
          })
        );
      if (output.format === "json") {
        throw new CliError(
          "validation",
          "--output json cannot frame a followed event stream; use text or stream-json"
        );
      }
      if (options.cursor) {
        throw new CliError("validation", "--cursor cannot be combined with --follow; use --after");
      }
      const controller = signalController();
      for await (const change of current.followEvents(id, {
        after: options.after,
        pollIntervalMs: options.pollInterval,
        timeoutMs: options.timeout,
        signal: controller.signal,
      }))
        output.result(change);
    });
  session
    .command("wait <id>")
    .option("--poll-interval <ms>", "poll interval in milliseconds", parseNumber, 1_000)
    .option("--timeout <ms>", "timeout in milliseconds", parseNumber, 60_000)
    .action(async (id, options, command) => {
      const controller = signalController();
      const result = await (
        await operations()
      ).operations.wait(id, {
        pollIntervalMs: options.pollInterval,
        timeoutMs: options.timeout,
        signal: controller.signal,
      });
      if (result.timedOut) {
        throw new CliError("timeout", "Session wait timed out", undefined, {
          sessionId: id,
          status: result.status,
        });
      }
      if (result.status === "failed") {
        throw new CliError("session_failed", "Session failed", undefined, {
          sessionId: id,
          status: result.status,
        });
      }
      outputFor(command).result(result);
    });
  session
    .command("messages <id>")
    .option("--limit <count>", "maximum messages", parseInteger)
    .option("--cursor <cursor>")
    .action(async (id, options, command) =>
      outputFor(command).result(await (await operations()).operations.messages(id, options))
    );
  session
    .command("artifacts <id>")
    .option("--artifact <artifact-id>", "retrieve artifact content")
    .option("--limit <count>", "maximum artifacts", parseInteger)
    .option("--offset <count>", "zero-based continuation offset", parseInteger)
    .action(async (id, options, command) => {
      const current = (await operations()).operations;
      outputFor(command).result(
        options.artifact
          ? await current.artifactContent(id, options.artifact, {
              limit: options.limit,
              offset: options.offset,
            })
          : await current.artifacts(id, { limit: options.limit })
      );
    });
  session
    .command("diff <id>")
    .option("--revision <revision-id>")
    .option("--file <file-id>")
    .option("--limit <count>", "maximum diff files", parseInteger)
    .option("--offset <count>", "zero-based continuation offset", parseInteger)
    .action(async (id, options, command) => {
      if (Boolean(options.revision) !== Boolean(options.file)) {
        throw new CliError("validation", "--revision and --file must be provided together");
      }
      const current = (await operations()).operations;
      outputFor(command).result(
        options.revision && options.file
          ? await current.diffFile(id, options.revision, options.file, {
              limit: options.limit,
              offset: options.offset,
            })
          : await current.diff(id, { limit: options.limit, offset: options.offset })
      );
    });
  session
    .command("prs <id>")
    .option("--pr <pull-request-id>", "retrieve one pull request")
    .option("--limit <count>", "maximum pull requests", parseInteger)
    .option("--offset <count>", "zero-based continuation offset", parseInteger)
    .action(async (id, options, command) => {
      const current = (await operations()).operations;
      outputFor(command).result(
        options.pr
          ? await current.pullRequest(id, options.pr)
          : await current.pullRequests(id, { limit: options.limit, offset: options.offset })
      );
    });
  session
    .command("children <id>")
    .option("--child <child-id>")
    .option("--limit <count>", "maximum children", parseInteger)
    .option("--offset <count>", "zero-based continuation offset", parseInteger)
    .action(async (id, options, command) => {
      const current = (await operations()).operations;
      outputFor(command).result(
        options.child
          ? await current.child(id, options.child)
          : await current.children(id, { limit: options.limit, offset: options.offset })
      );
    });
  session
    .command("child-prompt <id> <child-id>")
    .requiredOption("--content <text>")
    .option("--client-request-id <id>")
    .action(async (id, childId, options, command) => {
      const clientRequestId = options.clientRequestId ?? randomUUID();
      outputFor(command).result(
        await (
          await operations()
        ).operations.promptChild(id, childId, {
          content: options.content,
          clientRequestId,
        })
      );
    });

  program
    .command("mcp")
    .command("serve")
    .description("Run the local stdio MCP server")
    .action(async () => {
      await serveMcp((await operations("mcp")).operations);
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

function collect(value: string, values: string[]): string[] {
  return [...values, value];
}

async function readTextInput(path: string, stdin?: () => Promise<string>): Promise<string> {
  return path === "-" ? (stdin ?? readStdin)() : readFile(path, "utf8");
}

async function readJsonInput(
  path: string,
  stdin?: () => Promise<string>
): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await readTextInput(path, stdin));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError("validation", "Structured input must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function asAttachments(value: unknown): Array<{ attachmentId: string; name: string }> {
  return Array.isArray(value) ? (value as Array<{ attachmentId: string; name: string }>) : [];
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function uploadLocalAttachments(
  operations: Operations,
  sessionId: string,
  paths: string[],
  idempotencyKey: string
): Promise<Array<{ attachmentId: string; name: string }>> {
  const uploaded = [];
  const files = await Promise.all(
    paths.map(async (path) => {
      const bytes = await readFile(path);
      const name = basename(path);
      validateAttachmentBytes(bytes, name);
      return { bytes, name };
    })
  );
  for (const [index, { bytes, name }] of files.entries()) {
    const result = await operations.uploadAttachment(
      sessionId,
      new Blob([bytes]),
      name,
      `${idempotencyKey}:${index}`
    );
    uploaded.push({ attachmentId: result.attachmentId, name });
  }
  return uploaded;
}

async function validateLocalAttachmentPaths(paths: string[]): Promise<void> {
  await Promise.all(
    paths.map(async (path) => {
      const bytes = await readFile(path);
      validateAttachmentBytes(bytes, basename(path));
    })
  );
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

function isTransientLoginPollError(cause: unknown): boolean {
  return (
    cause instanceof CliError &&
    (cause.kind === "transport" ||
      cause.kind === "timeout" ||
      cause.kind === "rate_limited" ||
      cause.kind === "service")
  );
}

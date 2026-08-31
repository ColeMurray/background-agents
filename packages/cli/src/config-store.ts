import { createHash, randomUUID } from "node:crypto";
import { homedir, hostname, platform } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { readJsonFile, updateJsonFile } from "./atomic-json-file.js";
import { CliError } from "./errors.js";
import { type CredentialStore, selectCredentialStore } from "./credential-store.js";

const contextSchema = z.strictObject({
  url: z.url(),
  expiresAt: z.number().int().nonnegative(),
  credentialRef: z.string().uuid(),
});
const configSchema = z.strictObject({
  activeContext: z.string().min(1).nullable(),
  contexts: z.record(z.string().min(1), contextSchema),
});

export type StoredContext = Omit<z.infer<typeof contextSchema>, "credentialRef"> & {
  credential: string;
};
export type NamedContext = StoredContext & { name: string };
export type CliConfig = z.infer<typeof configSchema>;

function defaultConfigDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPEN_INSPECT_CONFIG_DIR) return env.OPEN_INSPECT_CONFIG_DIR;
  if (platform() === "win32")
    return join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Open Inspect");
  if (platform() === "darwin")
    return join(homedir(), "Library", "Application Support", "open-inspect");
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "open-inspect");
}

interface ConfigStoreOptions {
  credentialStore?: CredentialStore | Promise<CredentialStore>;
  generateCredentialRef?: () => string;
}

/** Stores an atomic URL/reference binding separately from immutable credential records. */
export class ConfigStore {
  readonly filePath: string;
  private readonly credentials: Promise<CredentialStore>;
  private readonly generateCredentialRef: () => string;

  constructor(directory?: string, options: ConfigStoreOptions = {}) {
    const resolvedDirectory = directory ?? defaultConfigDirectory();
    this.filePath = join(resolvedDirectory, "contexts.json");
    this.generateCredentialRef = options.generateCredentialRef ?? randomUUID;
    this.credentials = Promise.resolve(
      options.credentialStore ??
        selectCredentialStore(resolvedDirectory, {
          profile: createHash("sha256").update(resolvedDirectory).digest("hex").slice(0, 24),
          enableNative: directory === undefined,
        })
    );
  }

  async read(): Promise<CliConfig> {
    const value = await readJsonFile(this.filePath);
    return value === undefined ? { activeContext: null, contexts: {} } : configSchema.parse(value);
  }

  async credentialStoreKind(): Promise<CredentialStore["kind"]> {
    return (await this.credentials).kind;
  }

  async saveContext(name: string, context: StoredContext): Promise<void> {
    const credentialRef = this.generateCredentialRef();
    const metadata = contextSchema.parse({
      url: normalizeBaseUrl(context.url),
      expiresAt: context.expiresAt,
      credentialRef,
    });
    const credentials = await this.credentials;
    await credentials.set(credentialRef, context.credential);
    let previous: z.infer<typeof contextSchema> | undefined;
    try {
      await this.update((config) => {
        previous = config.contexts[name];
        config.contexts[name] = metadata;
        config.activeContext ??= name;
      });
    } catch (cause) {
      await credentials.delete(credentialRef);
      throw cause;
    }
    if (previous) {
      const previousContext = previous;
      try {
        await credentials.delete(previousContext.credentialRef);
      } catch (cause) {
        await this.update((config) => {
          if (config.contexts[name]?.credentialRef !== credentialRef) return;
          config.contexts[name] = previousContext;
        });
        await credentials.delete(credentialRef);
        throw cause;
      }
    }
  }

  async setActiveContext(name: string): Promise<void> {
    await this.update((config) => {
      if (!config.contexts[name]) throw new CliError("validation", `Context not found: ${name}`);
      config.activeContext = name;
    });
  }

  async getActiveContext(): Promise<NamedContext> {
    const config = await this.read();
    if (!config.activeContext)
      throw new CliError("auth", "Not logged in. Run `oi login --url <url>`.");
    const context = config.contexts[config.activeContext];
    if (!context) throw new CliError("auth", `Active context not found: ${config.activeContext}`);
    const credential = await (await this.credentials).get(context.credentialRef);
    if (!credential)
      throw new CliError("auth", `Credential not found for context: ${config.activeContext}`);
    return {
      name: config.activeContext,
      url: context.url,
      expiresAt: context.expiresAt,
      credential,
    };
  }

  async removeActiveContext(): Promise<NamedContext> {
    const current = await this.read();
    const removedName = current.activeContext;
    if (!removedName) throw new CliError("auth", "Not logged in. Run `oi login --url <url>`.");
    const removedContext = current.contexts[removedName];
    if (!removedContext) throw new Error(`Active context not found: ${removedName}`);
    const credentials = await this.credentials;
    const credential = await credentials.get(removedContext.credentialRef);
    if (!credential) throw new Error(`Credential not found for context: ${removedName}`);

    await credentials.delete(removedContext.credentialRef);
    try {
      await this.update((config) => {
        if (config.contexts[removedName]?.credentialRef !== removedContext.credentialRef)
          throw new Error(`Context changed while it was being removed: ${removedName}`);
        delete config.contexts[removedName];
        config.activeContext = Object.keys(config.contexts)[0] ?? null;
      });
    } catch (cause) {
      await credentials.set(removedContext.credentialRef, credential);
      throw cause;
    }
    return {
      name: removedName,
      url: removedContext.url,
      expiresAt: removedContext.expiresAt,
      credential,
    };
  }

  private async update(change: (config: CliConfig) => void): Promise<void> {
    await updateJsonFile(
      this.filePath,
      (value) =>
        value === undefined ? { activeContext: null, contexts: {} } : configSchema.parse(value),
      change
    );
  }
}

export function normalizeBaseUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (cause) {
    throw new CliError("validation", "Base URL is invalid", undefined, undefined, { cause });
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    throw new CliError("validation", "Base URL must use HTTP or HTTPS");
  const loopback =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]";
  if (parsed.protocol === "http:" && !loopback)
    throw new CliError(
      "validation",
      "HTTP base URLs are allowed only for localhost, 127.0.0.1, or [::1]"
    );
  if (parsed.username || parsed.password)
    throw new CliError("validation", "Base URL must not include credentials");
  if (parsed.search) throw new CliError("validation", "Base URL must not include a query string");
  if (parsed.hash) throw new CliError("validation", "Base URL must not include a fragment");
  if (parsed.pathname !== "/")
    throw new CliError("validation", "Base URL must not include a path prefix");
  return parsed.origin;
}

export function defaultDeviceName(): string {
  return hostname() || "Open Inspect CLI";
}

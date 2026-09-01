import { createHash, randomUUID } from "node:crypto";
import { homedir, hostname, platform } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { CLI_DEVICE_SECRET_PATTERN } from "@open-inspect/shared/types/cli-auth";
import { readJsonFile, updateJsonFile } from "./atomic-json-file.js";
import { CliError } from "./errors.js";
import { type CredentialStore, selectCredentialStore } from "./credential-store.js";

const RESERVED_CONTEXT_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const contextNameSchema = z
  .string()
  .min(1)
  .refine((name) => !RESERVED_CONTEXT_NAMES.has(name), "Reserved context name");
const contextSchema = z.strictObject({
  url: z.url(),
  expiresAt: z.number().int().nonnegative(),
  credentialRef: z.string().min(1),
});
const pendingRevocationSchema = z.strictObject({
  url: z.url(),
  credentialRef: z.string().min(1),
  credentialId: z.string().min(1).optional(),
  purpose: z.enum(["staged", "replaced"]).default("replaced"),
});
const pendingDeviceAuthorizationSchema = z.strictObject({
  url: z.url(),
  contextName: contextNameSchema,
  deviceSecretRef: z.string().min(1),
  state: z.enum(["recovery", "cleanup"]),
});
const configSchema = z.strictObject({
  activeContext: contextNameSchema.nullable(),
  contexts: z.record(contextNameSchema, contextSchema),
  pendingRevocations: z.array(pendingRevocationSchema).default([]),
  pendingDeviceAuthorizations: z.array(pendingDeviceAuthorizationSchema).default([]),
});

export type StoredContext = Omit<z.infer<typeof contextSchema>, "credentialRef"> & {
  credential: string;
};
export type IssuedContext = StoredContext & { credentialId: string };
export type StagedContext = Omit<IssuedContext, "credential"> & { credentialRef: string };
export type NamedContext = StoredContext & { name: string };
export type CliConfig = z.infer<typeof configSchema>;
export type PendingRevocation = z.infer<typeof pendingRevocationSchema> & {
  credential?: string;
};
export type PendingDeviceAuthorization = z.infer<typeof pendingDeviceAuthorizationSchema> & {
  deviceSecret?: string;
};
export type ConfigFileUpdater = (
  path: string,
  read: (value: unknown | undefined) => CliConfig,
  update: (value: CliConfig) => void
) => Promise<CliConfig>;

const emptyConfig = (): CliConfig => ({
  activeContext: null,
  contexts: {},
  pendingRevocations: [],
  pendingDeviceAuthorizations: [],
});

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
  updateConfigFile?: ConfigFileUpdater;
}

/** Stores an atomic URL/reference binding separately from immutable credential records. */
export class ConfigStore {
  readonly filePath: string;
  private readonly credentials: Promise<CredentialStore>;
  private readonly generateCredentialRef: () => string;
  private readonly updateConfigFile: ConfigFileUpdater;

  constructor(directory?: string, options: ConfigStoreOptions = {}) {
    const resolvedDirectory = directory ?? defaultConfigDirectory();
    this.filePath = join(resolvedDirectory, "contexts.json");
    this.generateCredentialRef = options.generateCredentialRef ?? randomUUID;
    this.updateConfigFile = options.updateConfigFile ?? updateJsonFile;
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
    return value === undefined ? emptyConfig() : configSchema.parse(value);
  }

  async credentialStoreKind(): Promise<CredentialStore["kind"]> {
    return (await this.credentials).kind;
  }

  async saveContext(name: string, context: StoredContext): Promise<void> {
    validateContextName(name);
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
        previous = ownContext(config, name);
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

  async stageCredential(context: IssuedContext): Promise<StagedContext> {
    const url = normalizeBaseUrl(context.url);
    const credentialRef = credentialReference(context.credentialId);
    const credentials = await this.credentials;
    try {
      await credentials.set(credentialRef, context.credential);
    } catch (cause) {
      throw new CliError(
        "service",
        "Credential secret could not be staged; retry with the same credential ID",
        undefined,
        { credentialId: context.credentialId, credentialRef },
        { cause }
      );
    }
    try {
      await this.update((config) => {
        const isBound = Object.values(config.contexts).some(
          (candidate) => candidate.credentialRef === credentialRef
        );
        const isPending = config.pendingRevocations.some(
          (candidate) => candidate.credentialRef === credentialRef
        );
        if (!isBound && !isPending)
          config.pendingRevocations.push({
            url,
            credentialRef,
            credentialId: context.credentialId,
            purpose: "staged",
          });
      });
    } catch (cause) {
      throw new CliError(
        "service",
        "Credential secret was staged, but its revocation marker could not be persisted; retry with the same credential ID",
        undefined,
        { credentialId: context.credentialId, credentialRef },
        { cause }
      );
    }
    return { url, expiresAt: context.expiresAt, credentialId: context.credentialId, credentialRef };
  }

  async stageDeviceAuthorization(input: {
    url: string;
    contextName: string;
    deviceSecret: string;
  }): Promise<string> {
    const url = normalizeBaseUrl(input.url);
    const contextName = validateContextName(input.contextName);
    const deviceSecretRef = deviceAuthorizationReference(input.deviceSecret);
    const credentials = await this.credentials;
    await credentials.set(deviceSecretRef, input.deviceSecret);
    try {
      await this.update((config) => {
        if (
          !config.pendingDeviceAuthorizations.some(
            (candidate) => candidate.deviceSecretRef === deviceSecretRef
          )
        ) {
          config.pendingDeviceAuthorizations.push({
            url,
            contextName,
            deviceSecretRef,
            state: "recovery",
          });
        }
      });
    } catch (cause) {
      await credentials.delete(deviceSecretRef);
      throw cause;
    }
    return deviceSecretRef;
  }

  async promoteStagedContext(
    name: string,
    staged: StagedContext,
    deviceSecretRef: string
  ): Promise<void> {
    validateContextName(name);
    const metadata = contextSchema.parse({
      url: staged.url,
      expiresAt: staged.expiresAt,
      credentialRef: staged.credentialRef,
    });
    await this.update((config) => {
      const authorization = config.pendingDeviceAuthorizations.find(
        (candidate) =>
          candidate.deviceSecretRef === deviceSecretRef && candidate.state === "recovery"
      );
      if (!authorization)
        throw new CliError("conflict", "Pending device authorization recovery was not found");
      const current = ownContext(config, name);
      if (current?.credentialRef === staged.credentialRef) {
        config.activeContext = name;
        authorization.state = "cleanup";
        return;
      }
      const hasMarker = config.pendingRevocations.some(
        (candidate) =>
          candidate.credentialRef === staged.credentialRef && candidate.purpose === "staged"
      );
      if (!hasMarker)
        throw new CliError("conflict", "Staged credential revocation marker was not found");
      const previous = current;
      config.contexts[name] = metadata;
      config.activeContext = name;
      config.pendingRevocations = config.pendingRevocations.filter(
        (candidate) => candidate.credentialRef !== staged.credentialRef
      );
      if (
        previous &&
        previous.credentialRef !== staged.credentialRef &&
        !config.pendingRevocations.some(
          (candidate) => candidate.credentialRef === previous.credentialRef
        )
      ) {
        config.pendingRevocations.push({
          url: previous.url,
          credentialRef: previous.credentialRef,
          purpose: "replaced",
        });
      }
      authorization.state = "cleanup";
    });
  }

  async getPendingRevocations(): Promise<PendingRevocation[]> {
    const config = await this.read();
    const credentials = await this.credentials;
    return Promise.all(
      config.pendingRevocations.map(async (pending) => {
        const credential = await credentials.get(pending.credentialRef);
        return { ...pending, ...(credential ? { credential } : {}) };
      })
    );
  }

  async getPendingDeviceAuthorizations(): Promise<PendingDeviceAuthorization[]> {
    const config = await this.read();
    const credentials = await this.credentials;
    return Promise.all(
      config.pendingDeviceAuthorizations.map(async (pending) => {
        const deviceSecret = await credentials.get(pending.deviceSecretRef);
        return { ...pending, ...(deviceSecret ? { deviceSecret } : {}) };
      })
    );
  }

  async completePendingDeviceAuthorization(deviceSecretRef: string): Promise<void> {
    const current = await this.read();
    const pending = current.pendingDeviceAuthorizations.find(
      (candidate) => candidate.deviceSecretRef === deviceSecretRef
    );
    if (!pending) return;
    await this.update((config) => {
      config.pendingDeviceAuthorizations = config.pendingDeviceAuthorizations.filter(
        (candidate) => candidate.deviceSecretRef !== deviceSecretRef
      );
    });
    await (await this.credentials).delete(deviceSecretRef);
  }

  async completePendingRevocation(credentialRef: string): Promise<void> {
    const current = await this.read();
    const pending = current.pendingRevocations.find(
      (candidate) => candidate.credentialRef === credentialRef
    );
    if (!pending) return;
    await this.update((config) => {
      config.pendingRevocations = config.pendingRevocations.filter(
        (candidate) => candidate.credentialRef !== credentialRef
      );
    });
    await (await this.credentials).delete(credentialRef);
  }

  async setActiveContext(name: string): Promise<void> {
    validateContextName(name);
    await this.update((config) => {
      if (!ownContext(config, name)) throw new CliError("validation", `Context not found: ${name}`);
      config.activeContext = name;
    });
  }

  async getActiveContext(): Promise<NamedContext> {
    const config = await this.read();
    if (!config.activeContext)
      throw new CliError("auth", "Not logged in. Run `oi login --url <url>`.");
    const context = ownContext(config, config.activeContext);
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
    const removedContext = ownContext(current, removedName);
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
    await this.updateConfigFile(
      this.filePath,
      (value) => (value === undefined ? emptyConfig() : configSchema.parse(value)),
      change
    );
  }
}

export function credentialReference(credentialId: string): string {
  const parsed = z.string().min(1).parse(credentialId);
  return `issued-${createHash("sha256").update(parsed).digest("hex")}`;
}

export function deviceAuthorizationReference(deviceSecret: string): string {
  const parsed = z.string().regex(CLI_DEVICE_SECRET_PATTERN).parse(deviceSecret);
  return `device-${createHash("sha256").update(parsed).digest("hex")}`;
}

export function validateContextName(name: string): string {
  const result = contextNameSchema.safeParse(name);
  if (!result.success) throw new CliError("validation", `Invalid context name: ${name}`);
  return result.data;
}

function ownContext(config: CliConfig, name: string): z.infer<typeof contextSchema> | undefined {
  return Object.prototype.hasOwnProperty.call(config.contexts, name)
    ? config.contexts[name]
    : undefined;
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

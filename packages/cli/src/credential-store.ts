import { join } from "node:path";
import { z } from "zod";
import { CLI_CREDENTIAL_PATTERN } from "@open-inspect/shared/types/cli-auth";
import { readJsonFile, updateJsonFile } from "./atomic-json-file.js";

const credentialSchema = z.string().regex(CLI_CREDENTIAL_PATTERN);
const credentialFileSchema = z.record(z.string().min(1), credentialSchema);
const NATIVE_SERVICE = "open-inspect-cli";

export interface CredentialStore {
  readonly kind: "native" | "file";
  get(reference: string): Promise<string | undefined>;
  set(reference: string, credential: string): Promise<void>;
  delete(reference: string): Promise<void>;
}

export interface NativeCredentialBackend {
  getPassword(service: string, account: string): Promise<string | null> | string | null;
  setPassword(service: string, account: string, credential: string): Promise<void> | void;
  deletePassword(service: string, account: string): boolean | void | Promise<boolean | void>;
}

interface KeyringEntry {
  getPassword(): string | null;
  setPassword(credential: string): void;
  deletePassword(): boolean | Promise<boolean>;
}

interface KeyringEntryConstructor {
  new (service: string, account: string): KeyringEntry;
}

export class FileCredentialStore implements CredentialStore {
  readonly kind = "file" as const;

  constructor(readonly filePath: string) {}

  async get(reference: string): Promise<string | undefined> {
    return this.parse(await readJsonFile(this.filePath))[reference];
  }

  async set(reference: string, credential: string): Promise<void> {
    credentialSchema.parse(credential);
    await updateJsonFile(
      this.filePath,
      (value) => this.parse(value),
      (values) => {
        values[reference] = credential;
      }
    );
  }

  async delete(reference: string): Promise<void> {
    await updateJsonFile(
      this.filePath,
      (value) => this.parse(value),
      (values) => {
        delete values[reference];
      }
    );
  }

  private parse(value: unknown | undefined): Record<string, string> {
    return value === undefined ? {} : credentialFileSchema.parse(value);
  }
}

class NativeCredentialStore implements CredentialStore {
  readonly kind = "native" as const;

  constructor(
    private readonly profile: string,
    private readonly backend: NativeCredentialBackend
  ) {}

  async get(reference: string): Promise<string | undefined> {
    const value = await this.backend.getPassword(NATIVE_SERVICE, this.account(reference));
    return value === null ? undefined : credentialSchema.parse(value);
  }

  async set(reference: string, credential: string): Promise<void> {
    credentialSchema.parse(credential);
    await this.backend.setPassword(NATIVE_SERVICE, this.account(reference), credential);
  }

  async delete(reference: string): Promise<void> {
    await this.backend.deletePassword(NATIVE_SERVICE, this.account(reference));
  }

  private account(reference: string): string {
    return `${this.profile}:${reference}`;
  }
}

export async function selectCredentialStore(
  directory: string,
  options: {
    platform?: NodeJS.Platform;
    profile?: string;
    nativeBackend?: NativeCredentialBackend;
    loadNativeBackend?: () => Promise<NativeCredentialBackend | undefined>;
    enableNative?: boolean;
  } = {}
): Promise<CredentialStore> {
  const currentPlatform = options.platform ?? process.platform;
  const supportsNative = ["darwin", "linux", "win32"].includes(currentPlatform);
  if (options.enableNative !== false && supportsNative) {
    const backend =
      options.nativeBackend ?? (await (options.loadNativeBackend ?? loadNativeBackend)());
    if (backend) return new NativeCredentialStore(options.profile ?? directory, backend);
  }
  return new FileCredentialStore(join(directory, "credentials.json"));
}

async function loadNativeBackend(): Promise<NativeCredentialBackend | undefined> {
  try {
    const { Entry } = await import("@napi-rs/keyring");
    return createNativeCredentialBackend(Entry);
  } catch (cause) {
    if (isUnavailableNativeModule(cause)) return undefined;
    throw cause;
  }
}

export function createNativeCredentialBackend(
  Entry: KeyringEntryConstructor
): NativeCredentialBackend {
  return {
    getPassword: (service, account) => new Entry(service, account).getPassword(),
    setPassword: (service, account, credential) =>
      new Entry(service, account).setPassword(credential),
    deletePassword: (service, account) => new Entry(service, account).deletePassword(),
  };
}

function isUnavailableNativeModule(cause: unknown): boolean {
  const code = (cause as NodeJS.ErrnoException).code;
  return code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND";
}

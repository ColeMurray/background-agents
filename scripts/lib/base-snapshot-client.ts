import { managedNamePattern } from "./base-snapshot-retention.ts";
import type {
  BaseSnapshot,
  BaseSnapshotClient,
  BaseSnapshotReference,
  BaseSnapshotScope,
} from "./base-snapshot-retention.ts";
import {
  DaytonaNotFoundError,
  DaytonaRestClient,
} from "../../packages/control-plane/src/sandbox/daytona-rest-client";
import {
  VercelSandboxApiError,
  VercelSandboxClient,
} from "../../packages/control-plane/src/sandbox/providers/vercel/client";

function timestamp(value: string | null | undefined): number {
  return value == null ? NaN : Date.parse(value);
}

export class VercelBaseSnapshotClient implements BaseSnapshotClient {
  constructor(
    private readonly client: Pick<
      VercelSandboxClient,
      "listNamedSandboxes" | "listAllSnapshots" | "deleteSnapshot"
    >,
    private readonly scope: BaseSnapshotScope
  ) {}

  async list(): Promise<BaseSnapshot[]> {
    const inventory: BaseSnapshot[] = [];
    const pattern = managedNamePattern(this.scope);
    for (const sandbox of await this.client.listNamedSandboxes({
      namePrefix: `${this.scope.prefix}-`,
    })) {
      if (!pattern.test(sandbox.name)) continue;
      for (const snapshot of await this.client.listAllSnapshots({ name: sandbox.name })) {
        inventory.push({
          id: snapshot.id,
          name: sandbox.name,
          createdAtMs: snapshot.createdAt,
          lastUsedAtMs: snapshot.lastUsedAt,
          ready: snapshot.status === "created",
          terminal: snapshot.status === "created" || snapshot.status === "failed",
        });
      }
    }
    return inventory;
  }

  async delete(snapshot: BaseSnapshotReference): Promise<void> {
    try {
      await this.client.deleteSnapshot(snapshot.id);
    } catch (error) {
      if (!(error instanceof VercelSandboxApiError && error.status === 404)) throw error;
    }
  }
}

export class DaytonaBaseSnapshotClient implements BaseSnapshotClient {
  constructor(
    private readonly client: Pick<DaytonaRestClient, "listSnapshots" | "deleteSnapshot">
  ) {}

  async list(): Promise<BaseSnapshot[]> {
    return (await this.client.listSnapshots()).map((snapshot) => ({
      id: snapshot.id,
      name: snapshot.name,
      createdAtMs: timestamp(snapshot.createdAt),
      lastUsedAtMs: snapshot.lastUsedAt == null ? undefined : timestamp(snapshot.lastUsedAt),
      ready: snapshot.state === "active" || snapshot.state === "inactive",
      terminal: ["active", "inactive", "error", "build_failed"].includes(snapshot.state),
    }));
  }

  async delete(snapshot: BaseSnapshotReference): Promise<void> {
    try {
      await this.client.deleteSnapshot(snapshot.id);
    } catch (error) {
      if (!(error instanceof DaytonaNotFoundError)) throw error;
    }
  }
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  if (!env[key]) throw new Error(`${key} is required`);
  return env[key];
}

// Operator guard only; each canonical client owns its default and URL normalization.
function providerUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = new URL(value);
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))
  ) {
    throw new Error("Provider URL must use HTTPS (HTTP is allowed only on loopback)");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash)
    throw new Error("Invalid provider URL");
  return value;
}

export function createSnapshotClient(
  policy: BaseSnapshotScope,
  env: NodeJS.ProcessEnv
): BaseSnapshotClient {
  switch (policy.provider) {
    case "vercel":
      return new VercelBaseSnapshotClient(
        new VercelSandboxClient(
          {
            token: required(env, "VERCEL_TOKEN"),
            projectId: required(env, "VERCEL_PROJECT_ID"),
            teamId: env.VERCEL_TEAM_ID,
            apiBaseUrl: providerUrl(env.VERCEL_SANDBOX_API_BASE_URL),
          },
          { info: (message, data) => console.error(JSON.stringify({ message, ...data })) }
        ),
        policy
      );
    case "daytona":
      return new DaytonaBaseSnapshotClient(
        new DaytonaRestClient({
          apiKey: required(env, "DAYTONA_API_KEY"),
          apiUrl: providerUrl(required(env, "DAYTONA_API_URL"))!,
        })
      );
  }
}

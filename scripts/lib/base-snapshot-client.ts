import { managedNamePattern } from "./base-snapshot-retention.mjs";
import { Snapshots } from "@opencomputer/sdk/node";
import {
  DaytonaNotFoundError,
  DaytonaRestClient,
} from "../../packages/control-plane/src/sandbox/daytona-rest-client";
import {
  VercelSandboxApiError,
  VercelSandboxClient,
} from "../../packages/control-plane/src/sandbox/providers/vercel/client";

export interface BaseSnapshotScope {
  provider: "vercel" | "daytona" | "opencomputer";
  prefix: string;
}

export interface BaseSnapshot {
  id: string;
  name: string;
  createdAtMs: number;
  lastUsedAtMs?: number;
  ready: boolean;
  terminal: boolean;
}

export interface BaseSnapshotClient {
  list(): Promise<BaseSnapshot[]>;
  delete(snapshot: Pick<BaseSnapshot, "id" | "name">): Promise<void>;
}

function timestamp(value: string | null | undefined): number {
  return value == null ? NaN : Date.parse(value);
}

export function vercelBaseSnapshots(
  client: Pick<VercelSandboxClient, "listNamedSandboxes" | "listAllSnapshots" | "deleteSnapshot">,
  scope: BaseSnapshotScope
): BaseSnapshotClient {
  return {
    async list() {
      const inventory: BaseSnapshot[] = [];
      const pattern = managedNamePattern(scope);
      for (const sandbox of await client.listNamedSandboxes({ namePrefix: `${scope.prefix}-` })) {
        if (!pattern.test(sandbox.name)) continue;
        for (const snapshot of await client.listAllSnapshots({ name: sandbox.name })) {
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
    },
    async delete(snapshot) {
      try {
        await client.deleteSnapshot(snapshot.id);
      } catch (error) {
        if (!(error instanceof VercelSandboxApiError && error.status === 404)) throw error;
      }
    },
  };
}

export function daytonaBaseSnapshots(
  client: Pick<DaytonaRestClient, "listSnapshots" | "deleteSnapshot">
): BaseSnapshotClient {
  return {
    async list() {
      return (await client.listSnapshots()).map((snapshot) => ({
        id: snapshot.id,
        name: snapshot.name,
        createdAtMs: timestamp(snapshot.createdAt),
        lastUsedAtMs: snapshot.lastUsedAt == null ? undefined : timestamp(snapshot.lastUsedAt),
        ready: snapshot.state === "active" || snapshot.state === "inactive",
        terminal: ["active", "inactive", "error", "build_failed"].includes(snapshot.state),
      }));
    },
    async delete(snapshot) {
      try {
        await client.deleteSnapshot(snapshot.id);
      } catch (error) {
        if (!(error instanceof DaytonaNotFoundError)) throw error;
      }
    },
  };
}

export function openComputerBaseSnapshots(
  client: Pick<Snapshots, "list" | "delete">
): BaseSnapshotClient {
  return {
    async list() {
      return (await client.list()).map((snapshot) => {
        if (typeof snapshot.id !== "string" || typeof snapshot.name !== "string")
          throw new Error("Invalid snapshot metadata");
        return {
          id: snapshot.id,
          name: snapshot.name,
          createdAtMs: timestamp(snapshot.createdAt),
          lastUsedAtMs: snapshot.lastUsedAt == null ? undefined : timestamp(snapshot.lastUsedAt),
          ready: snapshot.status === "ready",
          terminal: snapshot.status === "ready" || snapshot.status === "failed",
        };
      });
    },
    delete: (snapshot) => client.delete(snapshot.name),
  };
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
      return vercelBaseSnapshots(
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
      return daytonaBaseSnapshots(
        new DaytonaRestClient({
          apiKey: required(env, "DAYTONA_API_KEY"),
          apiUrl: providerUrl(required(env, "DAYTONA_API_URL"))!,
        })
      );
    case "opencomputer":
      return openComputerBaseSnapshots(
        new Snapshots({
          apiKey: required(env, "OPENCOMPUTER_API_KEY"),
          apiUrl: providerUrl(env.OPENCOMPUTER_API_URL),
        })
      );
  }
}

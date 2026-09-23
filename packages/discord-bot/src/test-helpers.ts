import { vi } from "vitest";
import type { Env, Interaction } from "./types";

export function createKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: vi.fn(async (key: string, type?: string) => {
      const value = store.get(key);
      if (value === undefined) return null;
      return type === "json" ? JSON.parse(value) : value;
    }),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
  };
}

export function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    DISCORD_KV: createKv() as unknown as KVNamespace,
    CONTROL_PLANE: { fetch: vi.fn() } as unknown as Env["CONTROL_PLANE"],
    DEPLOYMENT_NAME: "test",
    WEB_APP_URL: "https://web.example.com",
    DEFAULT_MODEL: "anthropic/claude-opus-5",
    DISCORD_APPLICATION_ID: "app-1",
    DISCORD_PUBLIC_KEY: "",
    DISCORD_ALLOWED_ROLE_IDS: "role-dev",
    DISCORD_ALLOWED_CHANNEL_IDS: "chan-tasks",
    DISCORD_BOT_TOKEN: "bot-token",
    SERVICE_AUTH_SECRET: "secret",
    ...overrides,
  };
}

export function createInteraction(overrides: Partial<Interaction> = {}): Interaction {
  return {
    id: "interaction-1",
    application_id: "app-1",
    type: 2,
    token: "interaction-token",
    guild_id: "guild-1",
    channel_id: "chan-tasks",
    member: {
      user: { id: "user-1", username: "agu", global_name: "Agu" },
      nick: null,
      roles: ["role-dev"],
    },
    data: {
      name: "task",
      options: [
        { name: "prompt", type: 3, value: "Make the icon black" },
        { name: "repo", type: 3, value: "agustind/andromeda-website" },
      ],
    },
    ...overrides,
  };
}

export function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

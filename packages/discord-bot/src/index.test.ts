import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import app from "./index";
import type * as taskModule from "./task";
import { handleTask } from "./task";
import { createEnv, createInteraction, toHex } from "./test-helpers";
import type { Env } from "./types";

vi.mock("./task", async (importOriginal) => ({
  ...(await importOriginal<typeof taskModule>()),
  handleTask: vi.fn(async () => undefined),
}));

let privateKey: CryptoKey;
let env: Env;

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  privateKey = pair.privateKey;
  const raw = (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer;
  env = createEnv({ DISCORD_PUBLIC_KEY: toHex(raw) });
});

afterEach(() => vi.clearAllMocks());

async function post(payload: unknown, options: { sign?: boolean } = {}) {
  const body = JSON.stringify(payload);
  const timestamp = "1700000000";
  const signature = toHex(
    await crypto.subtle.sign(
      { name: "Ed25519" },
      privateKey,
      new TextEncoder().encode(timestamp + body)
    )
  );
  const waitUntil = vi.fn();
  const response = await app.fetch(
    new Request("https://bot/interactions", {
      method: "POST",
      headers: {
        "x-signature-ed25519": options.sign === false ? "00".repeat(64) : signature,
        "x-signature-timestamp": timestamp,
      },
      body,
    }),
    env,
    { waitUntil, passThroughOnException: vi.fn(), props: {} } as unknown as ExecutionContext
  );
  return { response, json: (await response.json()) as Record<string, unknown>, waitUntil };
}

describe("POST /interactions", () => {
  it("rejects bad signatures", async () => {
    const { response } = await post({ type: 1 }, { sign: false });
    expect(response.status).toBe(401);
  });

  it("answers Discord's PING", async () => {
    const { json } = await post(createInteraction({ type: 1, data: undefined }));
    expect(json).toEqual({ type: 1 });
  });

  it("defers an allowed /task and processes it in the background", async () => {
    const { json, waitUntil } = await post(createInteraction());
    expect(json).toEqual({ type: 5 });
    expect(waitUntil).toHaveBeenCalledOnce();
    expect(vi.mocked(handleTask)).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ prompt: "Make the icon black", repo: "agustind/andromeda-website" })
    );
  });

  it("tells members without the role privately", async () => {
    const base = createInteraction();
    const { json, waitUntil } = await post(
      createInteraction({ member: { ...base.member!, roles: [] } })
    );
    expect(json).toMatchObject({
      type: 4,
      data: { content: "You need the dev role to submit tasks.", flags: 64 },
    });
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("hides the repository list from members without the role", async () => {
    const base = createInteraction();
    const { json } = await post(
      createInteraction({
        type: 4,
        member: { ...base.member!, roles: [] },
        data: { name: "task", options: [{ name: "repo", type: 3, value: "a", focused: true }] },
      })
    );
    expect(json).toEqual({ type: 8, data: { choices: [] } });
  });
});

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { PiSessionDO } from "../../src/cloudflare/pi-durable-object";
import { initSession, queryDO } from "./helpers";

function piStub(name: string): DurableObjectStub<PiSessionDO> {
  if (!env.PI_SESSION) throw new Error("PI_SESSION test binding is missing");
  return env.PI_SESSION.getByName(name);
}

describe("PiSessionDO", () => {
  it("creates a Pi SessionDO aggregate without any sandbox row", async () => {
    const { stub } = await initSession({
      harness: "pi",
      model: "openai/gpt-5.6-sol",
      reasoningEffort: "high",
    });

    await expect(queryDO(stub, "SELECT id FROM sandbox")).resolves.toEqual([]);
  });

  it("opens Pi's prefixed SQLite store and reports an idle root conversation", async () => {
    const stub = piStub(`pi-idle-${crypto.randomUUID()}`);
    await expect(stub.status("session-1")).resolves.toEqual({ busy: false, pending: 0 });
  });

  it("initializes idempotently for the same Open-Inspect session", async () => {
    const stub = piStub(`pi-repeat-${crypto.randomUUID()}`);
    await stub.status("session-1");
    await expect(stub.status("session-1")).resolves.toEqual({ busy: false, pending: 0 });
  });
});

import { beforeAll, describe, expect, it } from "vitest";
import { toHex } from "./test-helpers";
import { MAX_SIGNATURE_SKEW_MS, verifyDiscordSignature } from "./verify";

let publicKey: string;
let privateKey: CryptoKey;

async function sign(message: string): Promise<string> {
  return toHex(
    await crypto.subtle.sign({ name: "Ed25519" }, privateKey, new TextEncoder().encode(message))
  );
}

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  privateKey = pair.privateKey;
  publicKey = toHex((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
});

const SIGNED_AT_MS = 1_700_000_000_000;

describe("verifyDiscordSignature", () => {
  it("accepts a signature over timestamp + body", async () => {
    const body = '{"type":1}';
    const signature = await sign(`1700000000${body}`);
    await expect(
      verifyDiscordSignature({
        publicKey,
        signature,
        timestamp: "1700000000",
        body,
        nowMs: SIGNED_AT_MS,
      })
    ).resolves.toBe(true);
  });

  it("rejects a tampered body", async () => {
    const signature = await sign('1700000000{"type":1}');
    await expect(
      verifyDiscordSignature({
        publicKey,
        signature,
        timestamp: "1700000000",
        body: '{"type":2}',
        nowMs: SIGNED_AT_MS,
      })
    ).resolves.toBe(false);
  });

  it("rejects a valid signature with a stale timestamp", async () => {
    const body = '{"type":1}';
    const signature = await sign(`1700000000${body}`);
    await expect(
      verifyDiscordSignature({
        publicKey,
        signature,
        timestamp: "1700000000",
        body,
        nowMs: SIGNED_AT_MS + MAX_SIGNATURE_SKEW_MS + 1000,
      })
    ).resolves.toBe(false);
  });

  it("rejects missing headers and malformed hex", async () => {
    await expect(
      verifyDiscordSignature({ publicKey, signature: undefined, timestamp: "1", body: "" })
    ).resolves.toBe(false);
    await expect(
      verifyDiscordSignature({ publicKey, signature: "zz", timestamp: "1", body: "" })
    ).resolves.toBe(false);
    await expect(
      verifyDiscordSignature({
        publicKey: "abc",
        signature: "00".repeat(64),
        timestamp: "1",
        body: "",
      })
    ).resolves.toBe(false);
  });
});

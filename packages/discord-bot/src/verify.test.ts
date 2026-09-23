import { beforeAll, describe, expect, it } from "vitest";
import { toHex } from "./test-helpers";
import { verifyDiscordSignature } from "./verify";

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

describe("verifyDiscordSignature", () => {
  it("accepts a signature over timestamp + body", async () => {
    const body = '{"type":1}';
    const signature = await sign(`1700000000${body}`);
    await expect(
      verifyDiscordSignature({ publicKey, signature, timestamp: "1700000000", body })
    ).resolves.toBe(true);
  });

  it("rejects a tampered body", async () => {
    const signature = await sign('1700000000{"type":1}');
    await expect(
      verifyDiscordSignature({ publicKey, signature, timestamp: "1700000000", body: '{"type":2}' })
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

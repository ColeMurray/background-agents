import { describe, expect, it, vi } from "vitest";
import { computeHmacHex } from "@open-inspect/shared";
import type { Env } from "../types";
import {
  consumeImageBuildCallbackTokenOrThrow,
  generateImageBuildCallbackToken,
  hashImageBuildCallbackToken,
  ImageBuildCallbackAuthError,
  verifyImageBuildArtifactCallbackTokenOrThrow,
} from "./callback-auth";

const TOKEN = generateImageBuildCallbackToken();

const PARAMS = {
  buildId: "build-1",
  provider: "opencomputer" as const,
  providerSessionId: "ps-1",
  now: 1_700_000_000_000,
};

const ENV = { IMAGE_CALLBACK_TOKEN_PEPPER: "test-pepper" } as Env;

async function hashUnder(token: string, pepper: string): Promise<string> {
  return computeHmacHex(`repo-image-callback:${token}`, pepper);
}

describe("hashImageBuildCallbackToken", () => {
  it("hashes under the dedicated pepper", async () => {
    expect(await hashImageBuildCallbackToken(TOKEN, ENV)).toBe(
      await hashUnder(TOKEN, "test-pepper")
    );
  });

  it("ignores the retired INTERNAL_CALLBACK_SECRET entirely", async () => {
    const env = {
      IMAGE_CALLBACK_TOKEN_PEPPER: "test-pepper",
      INTERNAL_CALLBACK_SECRET: "legacy-secret",
    } as unknown as Env;
    expect(await hashImageBuildCallbackToken(TOKEN, env)).toBe(
      await hashUnder(TOKEN, "test-pepper")
    );
  });

  it("throws when the pepper is not configured", async () => {
    await expect(hashImageBuildCallbackToken(TOKEN, {} as Env)).rejects.toThrow(
      /IMAGE_CALLBACK_TOKEN_PEPPER/
    );
  });
});

describe("consumeImageBuildCallbackTokenOrThrow", () => {
  it("consumes with the single dedicated-pepper hash", async () => {
    const storedHash = await hashUnder(TOKEN, "test-pepper");
    const store = {
      consumeCallbackToken: vi.fn(async ({ tokenHash }: { tokenHash: string }) =>
        tokenHash === storedHash ? { id: "build-1" } : null
      ),
    };

    await expect(
      consumeImageBuildCallbackTokenOrThrow(store as never, ENV, TOKEN, PARAMS)
    ).resolves.toBeUndefined();
    expect(store.consumeCallbackToken).toHaveBeenCalledTimes(1);
  });

  it("a hash stored under the retired legacy pepper no longer consumes", async () => {
    const legacyHash = await hashUnder(TOKEN, "legacy-secret");
    const env = {
      IMAGE_CALLBACK_TOKEN_PEPPER: "test-pepper",
      INTERNAL_CALLBACK_SECRET: "legacy-secret",
    } as unknown as Env;
    const store = {
      consumeCallbackToken: vi.fn(async ({ tokenHash }: { tokenHash: string }) =>
        tokenHash === legacyHash ? { id: "build-1" } : null
      ),
    };

    await expect(
      consumeImageBuildCallbackTokenOrThrow(store as never, env, TOKEN, PARAMS)
    ).rejects.toThrow(ImageBuildCallbackAuthError);
    expect(store.consumeCallbackToken).toHaveBeenCalledTimes(1);
  });

  it("rejects when the hash does not consume", async () => {
    const store = { consumeCallbackToken: vi.fn().mockResolvedValue(null) };

    await expect(
      consumeImageBuildCallbackTokenOrThrow(store as never, ENV, TOKEN, PARAMS)
    ).rejects.toThrow(ImageBuildCallbackAuthError);
    expect(store.consumeCallbackToken).toHaveBeenCalledTimes(1);
  });

  it("reports misconfiguration when no pepper is bound", async () => {
    const store = { consumeCallbackToken: vi.fn() };
    await expect(
      consumeImageBuildCallbackTokenOrThrow(store as never, {} as Env, TOKEN, PARAMS)
    ).rejects.toMatchObject({ failure: "misconfigured" });
    expect(store.consumeCallbackToken).not.toHaveBeenCalled();
  });
});

describe("verifyImageBuildArtifactCallbackTokenOrThrow", () => {
  const ARTIFACT_PARAMS = { buildId: "build-1", provider: "modal" as const, now: PARAMS.now };

  it("verifies through the status-relaxed store check", async () => {
    const storedHash = await hashUnder(TOKEN, "test-pepper");
    const store = {
      verifyCallbackTokenForArtifactRecording: vi.fn(
        async ({ tokenHash }: { tokenHash: string }) => tokenHash === storedHash
      ),
    };

    await expect(
      verifyImageBuildArtifactCallbackTokenOrThrow(store as never, ENV, TOKEN, ARTIFACT_PARAMS)
    ).resolves.toBeUndefined();
    expect(store.verifyCallbackTokenForArtifactRecording).toHaveBeenCalledWith({
      ...ARTIFACT_PARAMS,
      tokenHash: storedHash,
    });
  });

  it("rejects a token that does not match", async () => {
    const store = {
      verifyCallbackTokenForArtifactRecording: vi.fn().mockResolvedValue(false),
    };
    await expect(
      verifyImageBuildArtifactCallbackTokenOrThrow(store as never, ENV, TOKEN, ARTIFACT_PARAMS)
    ).rejects.toThrow(ImageBuildCallbackAuthError);
  });
});

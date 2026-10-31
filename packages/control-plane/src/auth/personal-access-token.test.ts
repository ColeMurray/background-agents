import { describe, expect, it } from "vitest";
import { PERSONAL_ACCESS_TOKEN_PREFIX } from "@open-inspect/shared/types/personal-access-tokens";
import type { PersonalAccessTokenCredential } from "../db/personal-access-tokens";
import {
  authenticatePersonalAccessToken,
  personalAccessTokenDisplayPrefix,
  readPersonalAccessToken,
} from "./personal-access-token";

const TOKEN = `${PERSONAL_ACCESS_TOKEN_PREFIX}${"0123456789abcdef".repeat(4)}`;
const NOW = 1_700_000_000_000;

function headers(authorization?: string): Headers {
  return new Headers(authorization === undefined ? {} : { Authorization: authorization });
}

describe("readPersonalAccessToken", () => {
  it.each([`Bearer ${TOKEN}`, `bearer ${TOKEN}`, `BEARER  ${TOKEN}`, `Bearer ${TOKEN} `])(
    "reads a well-formed token from %j",
    (authorization) => {
      expect(readPersonalAccessToken(headers(authorization))).toBe(TOKEN);
    }
  );

  it.each([
    ["no header", undefined],
    ["another scheme", `Basic ${TOKEN}`],
    ["a sandbox token", "Bearer sandbox-token"],
    ["a truncated token", `Bearer ${TOKEN.slice(0, -1)}`],
    ["two credentials", `Bearer ${TOKEN} ${TOKEN}`],
  ])("ignores %s", (_label, authorization) => {
    expect(readPersonalAccessToken(headers(authorization))).toBeNull();
  });
});

describe("personalAccessTokenDisplayPrefix", () => {
  it("keeps the prefix and six characters of the secret", () => {
    expect(personalAccessTokenDisplayPrefix(TOKEN)).toBe(`${PERSONAL_ACCESS_TOKEN_PREFIX}012345`);
  });
});

describe("authenticatePersonalAccessToken", () => {
  const credential: PersonalAccessTokenCredential = {
    id: "token-1",
    userId: "user-1",
    displayPrefix: personalAccessTokenDisplayPrefix(TOKEN),
    expiresAt: NOW + 1,
    grant: ["sessions.read"],
  };
  const lookup = (found: PersonalAccessTokenCredential | null) => ({
    findByToken: async (token: string) => (token === TOKEN ? found : null),
  });

  it("resolves a live token to its credential", async () => {
    await expect(authenticatePersonalAccessToken(lookup(credential), TOKEN, NOW)).resolves.toBe(
      credential
    );
  });

  it("refuses an unknown token", async () => {
    await expect(authenticatePersonalAccessToken(lookup(null), TOKEN, NOW)).resolves.toBeNull();
  });

  it("refuses a token at its expiry instant", async () => {
    await expect(
      authenticatePersonalAccessToken(lookup(credential), TOKEN, NOW + 1)
    ).resolves.toBeNull();
  });
});

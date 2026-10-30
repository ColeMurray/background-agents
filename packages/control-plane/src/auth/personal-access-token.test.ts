import { describe, expect, it } from "vitest";
import {
  PERSONAL_ACCESS_TOKEN_PREFIX,
  type PersonalAccessTokenPolicy,
} from "@open-inspect/shared/types/personal-access-tokens";
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
  const DAY_MS = 24 * 60 * 60 * 1000;
  const credential: PersonalAccessTokenCredential = {
    id: "token-1",
    userId: "user-1",
    displayPrefix: personalAccessTokenDisplayPrefix(TOKEN),
    createdAt: NOW - DAY_MS,
    expiresAt: NOW + 1,
    grant: ["sessions.read", "automations.create"],
  };
  const open: PersonalAccessTokenPolicy = {
    enabled: true,
    maxLifetimeDays: null,
    allowedPermissions: null,
  };
  const lookup = (found: PersonalAccessTokenCredential | null) => ({
    findByToken: async (token: string) => (token === TOKEN ? found : null),
  });
  const policy = (rules: Partial<PersonalAccessTokenPolicy> = {}) => ({
    get: async () => ({ ...open, ...rules }),
  });

  it("resolves a live token to its credential", async () => {
    await expect(
      authenticatePersonalAccessToken(lookup(credential), policy(), TOKEN, NOW)
    ).resolves.toEqual({ kind: "authenticated", credential });
  });

  it("refuses an unknown token", async () => {
    await expect(
      authenticatePersonalAccessToken(lookup(null), policy(), TOKEN, NOW)
    ).resolves.toEqual({ kind: "rejected" });
  });

  it("refuses a token at its expiry instant", async () => {
    await expect(
      authenticatePersonalAccessToken(lookup(credential), policy(), TOKEN, NOW + 1)
    ).resolves.toEqual({ kind: "rejected" });
  });

  it("refuses every token, known or not, while the policy disables tokens", async () => {
    for (const found of [credential, null]) {
      await expect(
        authenticatePersonalAccessToken(lookup(found), policy({ enabled: false }), TOKEN, NOW)
      ).resolves.toEqual({ kind: "disabled" });
    }
  });

  it("ends an existing token early when the policy lowers the lifetime cap", async () => {
    const issuedLongAgo = { ...credential, createdAt: NOW - 40 * DAY_MS, expiresAt: NOW + DAY_MS };
    await expect(
      authenticatePersonalAccessToken(
        lookup(issuedLongAgo),
        policy({ maxLifetimeDays: 30 }),
        TOKEN,
        NOW
      )
    ).resolves.toEqual({ kind: "rejected" });
    await expect(
      authenticatePersonalAccessToken(
        lookup(issuedLongAgo),
        policy({ maxLifetimeDays: 90 }),
        TOKEN,
        NOW
      )
    ).resolves.toMatchObject({ kind: "authenticated" });
  });

  it("narrows an existing grant to the policy's permission ceiling", async () => {
    await expect(
      authenticatePersonalAccessToken(
        lookup(credential),
        policy({ allowedPermissions: ["sessions.read"] }),
        TOKEN,
        NOW
      )
    ).resolves.toEqual({
      kind: "authenticated",
      credential: { ...credential, grant: ["sessions.read"] },
    });
  });
});

import { randomBytes, randomUUID } from "node:crypto";
import type { SqlDatabase } from "../../src/db/sql-database";
import {
  mintBrowserSession,
  seedBrowserSession,
  signedOutBrowserCookie,
  type BrowserCookie,
  type BrowserStorageState,
} from "../support/browser-session";
import { PREVIEW_LIFETIME_MS, randomSecret } from "./config";

import { PERSONAS, type Persona } from "./contracts";
export { PERSONAS, type Persona } from "./contracts";
export interface PreviewIdentity {
  userId: string | null;
  cookieHeader: string;
  storageState: BrowserStorageState;
  expiresAtMs: number;
}
export async function seedPersonas(
  database: SqlDatabase,
  publicWebOrigin: string,
  secret: string
): Promise<Record<Persona, PreviewIdentity>> {
  const nowMs = Date.now();
  const identities = {} as Record<Persona, PreviewIdentity>;
  for (const persona of PERSONAS) {
    const expiresAtMs = nowMs + (persona === "expired" ? -60_000 : PREVIEW_LIFETIME_MS);
    if (persona === "anonymous") {
      identities[persona] = {
        userId: null,
        cookieHeader: "",
        storageState: { cookies: [], origins: [] },
        expiresAtMs,
      };
      continue;
    }
    const userId = randomBytes(16).toString("hex");
    const session = await seedBrowserSession(
      database,
      { publicWebOrigin, secret },
      {
        userId,
        identityId: randomUUID(),
        providerSubject: String(randomBytes(6).readUIntBE(0, 6)),
        name: `Preview ${persona}`,
        email: `${persona}@preview.test`,
        role: persona === "owner" || persona === "viewer" ? persona : "member",
        suspendedAt: persona === "suspended" ? nowMs : undefined,
        sessionId: randomUUID(),
        token: randomSecret(),
        nowMs,
        expiresAtMs,
      }
    );
    identities[persona] = { userId, ...session, expiresAtMs };
  }
  return identities;
}

/**
 * The cookie that makes a browser this persona from now on. Sign-out deletes sessions, so each
 * call mints a new one for the seeded user; `anonymous` gets the login cookie cleared instead.
 */
export async function signInPersona(
  database: SqlDatabase,
  publicWebOrigin: string,
  secret: string,
  identity: PreviewIdentity
): Promise<BrowserCookie> {
  if (identity.userId === null)
    return signedOutBrowserCookie(database, { publicWebOrigin, secret });
  const { storageState } = await mintBrowserSession(
    database,
    { publicWebOrigin, secret },
    {
      userId: identity.userId,
      sessionId: randomUUID(),
      token: randomSecret(),
      nowMs: Date.now(),
      expiresAtMs: identity.expiresAtMs,
    }
  );
  return storageState.cookies[0];
}

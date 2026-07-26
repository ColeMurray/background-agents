import { z } from "zod";
import type { AuthenticationContext } from "./principal";
import type { BrowserAuthRuntime } from "./browser-auth-runtime";
import type { SqlDatabase } from "../db/sql-database";

const sessionSchema = z.object({
  session: z.object({
    id: z.string().min(1),
    userId: z.string().min(1),
  }),
  user: z.object({
    id: z.string().min(1),
  }),
});

const providerAccountSchema = z.object({
  id: z.string().min(1),
  provider_id: z.string().min(1),
  account_id: z.string().min(1),
  user_id: z.string().min(1),
});

export interface AuthenticatedBrowserUser {
  readonly userId: string;
  readonly authentication: AuthenticationContext & {
    readonly mechanism: "browser_session";
  };
}

export class BrowserSessionIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserSessionIntegrityError";
  }
}

export async function authenticateBrowserSession(
  auth: BrowserAuthRuntime,
  db: SqlDatabase,
  headers: Headers
): Promise<AuthenticatedBrowserUser | null> {
  const candidate = await auth.api.getSession({
    headers,
    query: { disableRefresh: true },
  });
  if (candidate === null) return null;

  const parsedSession = sessionSchema.safeParse(candidate);
  if (!parsedSession.success) {
    throw new BrowserSessionIntegrityError("Better Auth returned a malformed session");
  }
  const { session, user } = parsedSession.data;
  if (session.userId !== user.id) {
    throw new BrowserSessionIntegrityError("Better Auth returned a cross-user session");
  }

  const result = await db
    .prepare(
      `SELECT
         id,
         providerId AS provider_id,
         accountId AS account_id,
         userId AS user_id
       FROM auth_accounts
       WHERE userId = ?
       ORDER BY id
       LIMIT 2`
    )
    .bind(user.id)
    .all();
  if (result.results.length !== 1) {
    throw new BrowserSessionIntegrityError(
      "Browser session does not resolve to exactly one provider account"
    );
  }
  const parsedAccount = providerAccountSchema.safeParse(result.results[0]);
  if (!parsedAccount.success || parsedAccount.data.user_id !== user.id) {
    throw new BrowserSessionIntegrityError("Browser session provider account is corrupt");
  }

  return {
    userId: user.id,
    authentication: {
      mechanism: "browser_session",
      credentialId: session.id,
      providerAccount: {
        id: parsedAccount.data.id,
        provider: parsedAccount.data.provider_id,
        subject: parsedAccount.data.account_id,
      },
      channel: {
        kind: "sig1",
        service: "web",
      },
    },
  };
}

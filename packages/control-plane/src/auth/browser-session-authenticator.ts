import { z } from "zod";
import type { AuthenticationContext } from "./principal";
import type { BrowserAuthRuntime } from "./browser-auth-runtime";

const sessionSchema = z.object({
  session: z.object({
    id: z.string().min(1),
    userId: z.string().min(1),
  }),
  user: z.object({
    id: z.string().min(1),
  }),
});

export interface AuthenticatedBrowserUser {
  readonly userId: string;
  readonly authentication: AuthenticationContext;
}

export class BrowserSessionIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserSessionIntegrityError";
  }
}

export async function authenticateBrowserSession(
  auth: BrowserAuthRuntime,
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

  return {
    userId: user.id,
    authentication: {
      mechanism: "browser_session",
      credentialId: session.id,
      channel: {
        kind: "sig1",
        service: "web",
      },
    },
  };
}

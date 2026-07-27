/**
 * Adapts a Better Auth browser session into the control plane's authentication model.
 *
 * `authenticate()` calls this module only after validating the `service:web`
 * sig1 channel. This adapter delegates opaque session-cookie verification and
 * session lookup to Better Auth, verifies that the returned session and user
 * agree, and emits provider-independent authentication evidence for the
 * control-plane router. It does not perform authorization or resolve the
 * provider account originally used to sign in.
 *
 * Protected resource requests use a non-refreshing session read so validation
 * does not extend session expiry or write D1 as a side effect. Browser-facing
 * Better Auth session endpoints remain responsible for session refresh.
 */

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
  // Resource authentication is a read-only hot path, not a session-lifecycle endpoint.
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

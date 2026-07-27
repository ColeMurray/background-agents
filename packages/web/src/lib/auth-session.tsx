"use client";

import useSWR, { mutate } from "swr";
import { z } from "zod";
import {
  browserAuthSessionResponseSchema,
  type BrowserAuthSessionUser,
} from "./browser-auth-session-contract";
import { browserApiFetch } from "./browser-api-fetch";
import type { AuthProvider } from "./build-auth-identity";

const BROWSER_AUTH_SESSION_PATH = "/api/auth/get-session";

export type AuthSessionUser = BrowserAuthSessionUser;

export interface AuthSession {
  user: AuthSessionUser;
}

export type SignInProvider = AuthProvider;

export type AuthSessionState =
  | {
      data: AuthSession;
      status: "authenticated";
    }
  | {
      data: null;
      status: "loading" | "unauthenticated";
    };

export type AuthSessionStatus = AuthSessionState["status"];

export async function signIn(provider: SignInProvider): Promise<void> {
  const response = await browserApiFetch("/api/auth/sign-in/social", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider,
      callbackURL: "/",
      disableRedirect: true,
    }),
  });
  if (!response.ok) {
    throw new Error(`Sign-in failed with status ${response.status}`);
  }

  const { url } = z.object({ url: z.url() }).parse(await response.json());
  const destination = new URL(url);
  if (destination.protocol !== "https:") {
    throw new Error("Sign-in returned an insecure redirect URL");
  }
  globalThis.location.assign(destination.href);
}

export async function signOut(): Promise<void> {
  const response = await browserApiFetch("/api/auth/sign-out", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!response.ok) {
    throw new Error(`Sign-out failed with status ${response.status}`);
  }
  await mutate(BROWSER_AUTH_SESSION_PATH, null, false);
}

/**
 * App-owned client authentication boundary.
 */
export function useAuthSession(): AuthSessionState {
  const { data, error, isLoading } = useSWR<AuthSession | null>(
    BROWSER_AUTH_SESSION_PATH,
    async () => {
      const response = await browserApiFetch(BROWSER_AUTH_SESSION_PATH);
      if (!response.ok) {
        throw new Error(`Session lookup failed with status ${response.status}`);
      }
      const payload: unknown = await response.json();
      if (payload === null) return null;
      const session = browserAuthSessionResponseSchema.parse(payload);
      return { user: session.user };
    }
  );

  if (data) return { data, status: "authenticated" };
  if (error) {
    return { data: null, status: "unauthenticated" };
  }
  if (isLoading || data === undefined) {
    return { data: null, status: "loading" };
  }
  return { data: null, status: "unauthenticated" };
}

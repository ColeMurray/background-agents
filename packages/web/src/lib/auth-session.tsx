"use client";

import type { ReactNode } from "react";
import {
  SessionProvider,
  signIn as nextAuthSignIn,
  signOut as nextAuthSignOut,
  useSession,
} from "next-auth/react";
import type { AuthProvider } from "./build-auth-identity";

export interface AuthSessionUser {
  name?: string | null;
  image?: string | null;
}

export interface AuthSession {
  user?: AuthSessionUser | null;
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

export function AuthSessionProvider({ children }: { children: ReactNode }) {
  return <SessionProvider refetchOnWindowFocus={false}>{children}</SessionProvider>;
}

export async function signIn(provider: SignInProvider): Promise<void> {
  await nextAuthSignIn(provider);
}

export async function signOut(): Promise<void> {
  await nextAuthSignOut();
}

/**
 * App-owned client authentication boundary.
 *
 * The current implementation delegates to NextAuth. Terminal browser auth can
 * replace this module without another repository-wide consumer migration.
 */
export function useAuthSession(): AuthSessionState {
  const state = useSession();
  if (state.status === "authenticated") {
    return { data: state.data, status: state.status };
  }
  return { data: null, status: state.status };
}

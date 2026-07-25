"use client";

import type { ReactNode } from "react";
import {
  SessionProvider,
  signIn as nextAuthSignIn,
  signOut as nextAuthSignOut,
  useSession,
} from "next-auth/react";

export interface AuthSessionUser {
  name?: string | null;
  image?: string | null;
}

export interface AuthSession {
  user?: AuthSessionUser | null;
}

export type AuthSessionStatus = "loading" | "authenticated" | "unauthenticated";
export type SignInProvider = "github" | "google";

export interface AuthSessionState {
  data: AuthSession | null;
  status: AuthSessionStatus;
}

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
  const { data, status } = useSession();
  return { data, status };
}

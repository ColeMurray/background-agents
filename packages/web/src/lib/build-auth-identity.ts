export type AuthProvider = "github" | "google";

export function isAuthProvider(value: string | null | undefined): value is AuthProvider {
  return value === "github" || value === "google";
}

export interface AuthDisplayUser {
  readonly name?: string | null;
  readonly email?: string | null;
  readonly image?: string | null;
}

export interface AuthDisplay {
  readonly authEmail?: string;
  readonly authName?: string;
  readonly authAvatarUrl?: string;
}

/**
 * Cosmetic user attributes allowed in session and automation bodies.
 *
 * The authenticated principal and provider/SCM provenance are control-plane
 * state; this helper deliberately cannot express those authority-bearing
 * fields.
 */
export function buildAuthDisplay(user: AuthDisplayUser | null | undefined): AuthDisplay {
  return {
    authEmail: user?.email ?? undefined,
    authName: user?.name ?? undefined,
    authAvatarUrl: user?.image ?? undefined,
  };
}

export interface AuthDisplayUser {
  readonly name?: string | null;
  readonly email?: string | null;
  readonly image?: string | null;
}

export interface AuthDisplay {
  readonly actorEmail?: string;
  readonly actorDisplayName?: string;
  readonly actorAvatarUrl?: string;
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
    actorEmail: user?.email ?? undefined,
    actorDisplayName: user?.name ?? undefined,
    actorAvatarUrl: user?.image ?? undefined,
  };
}

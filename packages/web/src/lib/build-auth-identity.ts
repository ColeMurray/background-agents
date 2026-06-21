/**
 * Single chokepoint for the auth-provider discriminator on the web side.
 *
 * Every request body we send to the control plane separates two concerns:
 *
 * - `auth*` — provider-agnostic authentication identity ("who logged in").
 *   Populated for BOTH GitHub and Google; resolves the canonical D1 user.
 * - `scm*` — GitHub-only SCM credentials + git-commit attribution. Populated
 *   ONLY for GitHub; a Google session carries no `scm*` at all.
 *
 * Keeping the `provider === "github"` decision in this one module is the whole
 * point of the 4B split — otherwise the branch sprawls across every route and
 * a Google token can leak into the SCM path. Both `sessions` and `ws-token`
 * routes build their bodies from these helpers and never branch on provider
 * themselves.
 */

export type AuthProvider = "github" | "google";

/**
 * Validated narrowing for the auth-provider discriminator. Returns true only for
 * a provider this app explicitly supports, so an unrecognized value fails closed
 * at the boundary instead of being cast onto the union.
 */
export function isAuthProvider(value: string | null | undefined): value is AuthProvider {
  return value === "github" || value === "google";
}

export interface AuthIdentityUser {
  id?: string | null;
  login?: string | null;
  name?: string | null;
  email?: string | null;
  image?: string | null;
  provider?: AuthProvider;
}

export interface AuthIdentity {
  authProvider: AuthProvider;
  authUserId?: string;
  authEmail?: string;
  authName?: string;
  authAvatarUrl?: string;
}

export interface ScmTokenSource {
  accessToken?: string;
  refreshToken?: string;
  accessTokenExpiresAt?: number;
}

export interface ScmCredentials {
  scmUserId?: string;
  scmLogin?: string;
  scmName?: string;
  scmEmail?: string;
  scmAvatarUrl?: string;
  scmToken?: string;
  scmRefreshToken?: string;
  scmTokenExpiresAt?: number;
}

/**
 * Resolve the authentication provider for a session user. Legacy GitHub
 * sessions were minted before `provider` existed, so a missing provider is
 * treated as GitHub — the same back-compat default the control plane applies
 * (`authProvider ?? "github"`).
 */
export function resolveAuthProvider(user: AuthIdentityUser | null | undefined): AuthProvider {
  return user?.provider ?? "github";
}

/**
 * Provider-agnostic identity block. Sent for every provider so the control
 * plane can resolve the canonical user via `/provider-identities/:provider/:id`.
 */
export function buildAuthIdentity(user: AuthIdentityUser | null | undefined): AuthIdentity {
  return {
    authProvider: resolveAuthProvider(user),
    authUserId: user?.id ?? undefined,
    authEmail: user?.email ?? undefined,
    authName: user?.name ?? undefined,
    authAvatarUrl: user?.image ?? undefined,
  };
}

/**
 * GitHub SCM credentials + git-commit attribution. Returns an empty object for
 * non-GitHub providers (e.g. Google) so their request bodies carry no `scm*`
 * fields and no OAuth token — the credential-leak gate the F1/F2 findings call
 * for, enforced here at the single source rather than at each call site.
 */
export function buildScmCredentials(
  user: AuthIdentityUser | null | undefined,
  tokens: ScmTokenSource | null | undefined
): ScmCredentials {
  if (resolveAuthProvider(user) !== "github") {
    return {};
  }

  return {
    scmUserId: user?.id ?? undefined,
    scmLogin: user?.login ?? undefined,
    scmName: user?.name ?? undefined,
    scmEmail: user?.email ?? undefined,
    scmAvatarUrl: user?.image ?? undefined,
    scmToken: tokens?.accessToken,
    scmRefreshToken: tokens?.refreshToken,
    scmTokenExpiresAt: tokens?.accessTokenExpiresAt,
  };
}

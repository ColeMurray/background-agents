/**
 * Single chokepoint for the auth-provider discriminator on the web side.
 *
 * Under identity enforcement the control plane derives WHO the caller is
 * (userId, authProvider/authUserId, SCM credentials) from the authenticated
 * Bearer principal and rejects those fields in identity-route bodies. What the
 * web still sends over the wire is display-only:
 *
 * - `auth*` display block (`buildAuthDisplay`) — email/name/avatar for BOTH
 *   GitHub and Google.
 * - `scm*` attribution block (`buildScmAttribution`) — GitHub-only
 *   login/name/email/avatar for git-commit attribution; a Google session
 *   carries no `scm*` at all.
 *
 * `buildAuthIdentity` (with `authProvider`/`authUserId`) remains for the
 * provider-identity resolution path (`/provider-identities/:provider/:id`),
 * which is not an identity-enforced route.
 *
 * Keeping the `provider === "github"` decision in this one module is the whole
 * point of the 4B split — otherwise the branch sprawls across every route and
 * GitHub-only fields can leak into a Google request. The `sessions`,
 * `ws-token`, and `automations` routes build their bodies from these helpers
 * and never branch on provider themselves.
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

export interface AuthDisplay {
  authEmail?: string;
  authName?: string;
  authAvatarUrl?: string;
}

export interface ScmAttribution {
  scmLogin?: string;
  scmName?: string;
  scmEmail?: string;
  scmAvatarUrl?: string;
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
 * Provider-agnostic identity block, used to resolve the canonical user via
 * `/provider-identities/:provider/:id`. NOT for identity-route bodies:
 * `authProvider`/`authUserId` are forbidden there under strict enforcement —
 * send `buildAuthDisplay` instead.
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
 * Display-only auth block for identity-route bodies. The control plane keeps
 * these body-carried by design; the identifying fields (`authProvider`,
 * `authUserId`) come from the Bearer principal and must not be sent.
 */
export function buildAuthDisplay(user: AuthIdentityUser | null | undefined): AuthDisplay {
  return {
    authEmail: user?.email ?? undefined,
    authName: user?.name ?? undefined,
    authAvatarUrl: user?.image ?? undefined,
  };
}

/**
 * GitHub-only git-commit attribution (display fields, no credentials). Returns
 * an empty object for non-GitHub providers (e.g. Google) so their request
 * bodies carry no `scm*` fields at all — the provider gate the F1/F2 findings
 * call for, enforced here at the single source rather than at each call site.
 *
 * SCM credentials (`scmUserId`/`scmToken`/`scmRefreshToken`/expiry) are never
 * sent: the control plane derives them from the authenticated principal's
 * token store and strict enforcement rejects them in the body.
 */
export function buildScmAttribution(user: AuthIdentityUser | null | undefined): ScmAttribution {
  if (resolveAuthProvider(user) !== "github") {
    return {};
  }

  return {
    scmLogin: user?.login ?? undefined,
    scmName: user?.name ?? undefined,
    scmEmail: user?.email ?? undefined,
    scmAvatarUrl: user?.image ?? undefined,
  };
}

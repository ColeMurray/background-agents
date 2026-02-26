interface SessionUserIdentity {
  id?: string;
  login?: string;
  name?: string | null;
  email?: string | null;
}

function buildGitHubNoreplyEmail(userId: string | undefined, login: string): string {
  return userId
    ? `${userId}+${login}@users.noreply.github.com`
    : `${login}@users.noreply.github.com`;
}

export function resolveScmIdentity(user: SessionUserIdentity): {
  scmUserId: string | null;
  scmLogin: string | null;
  scmName: string | null;
  scmEmail: string | null;
} {
  const scmUserId = user.id ?? null;
  const scmLogin = user.login ?? null;
  const scmName = user.name ?? scmLogin;
  const scmEmail =
    user.email ?? (scmLogin ? buildGitHubNoreplyEmail(scmUserId ?? undefined, scmLogin) : null);

  return {
    scmUserId,
    scmLogin,
    scmName,
    scmEmail,
  };
}

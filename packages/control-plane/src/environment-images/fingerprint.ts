/**
 * Members fingerprint — the identity of an environment's buildable repo set.
 *
 * A fingerprint is a SHA-256 over the ordered (owner, name, base_branch)
 * triples of an environment's members (design §7.3). It is computed
 * control-plane-side only: at build registration (from the member set the
 * build was handed) and at spawn matching (from the session's own snapshot,
 * PR-11) — never by the data plane, so the algorithm has exactly one home.
 */

export interface FingerprintMemberInput {
  repoOwner: string;
  repoName: string;
  baseBranch: string;
}

/**
 * Order-sensitive by design: members are position-ordered and setup hooks run
 * in that order, so a reordered environment is a different build. Owner/name
 * are lowercased to match repo-identity comparisons elsewhere; branch names
 * stay case-sensitive (git refs are).
 */
export async function computeMembersFingerprint(
  members: FingerprintMemberInput[]
): Promise<string> {
  const canonical = JSON.stringify(
    members.map((member) => [
      member.repoOwner.toLowerCase(),
      member.repoName.toLowerCase(),
      member.baseBranch,
    ])
  );
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

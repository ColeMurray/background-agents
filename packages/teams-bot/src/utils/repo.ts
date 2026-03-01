/**
 * Repository identifier utilities.
 */

export function normalizeRepoId(owner: string, name: string): string {
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}

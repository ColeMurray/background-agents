/**
 * One member repository row, in position order (position 0 = primary).
 */
export interface SessionRepositoryRow {
  position: number;
  repo_owner: string;
  repo_name: string;
  repo_id: number | null;
  base_branch: string;
  branch_name: string | null;
  base_sha: string | null;
  current_sha: string | null;
}

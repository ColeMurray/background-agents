import type {
  LinearIssue,
  ListIssuesOptions,
  CreateIssueInput,
  UpdateIssueInput,
} from "../linear/client";

export interface LinearPort {
  listIssues(
    teamId: string,
    filters?: ListIssuesOptions
  ): Promise<{ issues: LinearIssue[]; cursor: string | null; hasMore: boolean }>;
  getIssue(issueId: string): Promise<LinearIssue | null>;
  createIssue(input: CreateIssueInput): Promise<LinearIssue>;
  updateIssue(issueId: string, input: UpdateIssueInput): Promise<LinearIssue>;
  listTeams(): Promise<Array<{ id: string; key: string; name: string }>>;
}

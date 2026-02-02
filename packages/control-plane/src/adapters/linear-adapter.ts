import {
  listIssues,
  getIssue,
  createIssue,
  updateIssue,
  listTeams,
  type ListIssuesOptions,
  type CreateIssueInput,
  type UpdateIssueInput,
  type LinearIssue,
} from "../linear/client";
import type { LinearPort } from "../ports/linear-port";

export class LinearAdapter implements LinearPort {
  constructor(private apiKey: string) {}

  private get env() {
    return { LINEAR_API_KEY: this.apiKey };
  }

  async listIssues(
    teamId: string,
    filters?: ListIssuesOptions
  ): Promise<{ issues: LinearIssue[]; cursor: string | null; hasMore: boolean }> {
    return listIssues(this.env, { teamId, ...filters });
  }

  async getIssue(issueId: string): Promise<LinearIssue | null> {
    return getIssue(this.env, issueId);
  }

  async createIssue(input: CreateIssueInput): Promise<LinearIssue> {
    return createIssue(this.env, input);
  }

  async updateIssue(issueId: string, input: UpdateIssueInput): Promise<LinearIssue> {
    return updateIssue(this.env, issueId, input);
  }

  async listTeams(): Promise<Array<{ id: string; key: string; name: string }>> {
    return listTeams(this.env);
  }
}

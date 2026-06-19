import {
  DEFAULT_WORKSPACE_ID,
  type EnrichedRepository,
  type InstallationRepository,
  type Workspace,
  type WorkspaceRepository,
} from "@open-inspect/shared";

interface WorkspaceRow {
  id: string;
  key: string;
  name: string;
  status: "active" | "archived";
  created_at: number;
  updated_at: number;
}

interface WorkspaceRepositoryRow {
  workspace_id: string;
  provider: string;
  repo_id: number | null;
  repo_owner: string;
  repo_name: string;
  role: "execution" | "context";
  active: number;
  default_branch: string | null;
  created_at: number;
  updated_at: number;
}

export interface WorkspaceRepositoryAccessResult {
  ok: boolean;
  status: number;
  message: string;
  workspaceId?: string;
}

function nowMs(): number {
  return Date.now();
}

function normalizeRepoPart(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeWorkspaceIdentifier(value: string | null | undefined): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_WORKSPACE_ID;
}

function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function defaultWorkspace(): Workspace {
  const now = nowMs();
  return {
    id: DEFAULT_WORKSPACE_ID,
    key: DEFAULT_WORKSPACE_ID,
    name: "Default Workspace",
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
}

function toWorkspaceRepository(row: WorkspaceRepositoryRow): WorkspaceRepository {
  return {
    workspaceId: row.workspace_id,
    provider: row.provider,
    repoId: row.repo_id,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    role: row.role,
    active: row.active === 1,
    defaultBranch: row.default_branch,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class WorkspaceStore {
  constructor(private readonly db: D1Database) {}

  async ensureDefaultWorkspace(): Promise<void> {
    const now = nowMs();
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO workspaces (id, key, name, status, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?)`
      )
      .bind(DEFAULT_WORKSPACE_ID, DEFAULT_WORKSPACE_ID, "Default Workspace", now, now)
      .run();
  }

  async listWorkspaces(): Promise<Workspace[]> {
    await this.ensureDefaultWorkspace();

    const result = await this.db
      .prepare("SELECT * FROM workspaces WHERE status = 'active' ORDER BY name ASC")
      .all<WorkspaceRow>();

    return (result.results ?? []).map(toWorkspace);
  }

  async resolveWorkspace(identifier?: string | null): Promise<Workspace | null> {
    await this.ensureDefaultWorkspace();
    const normalized = normalizeWorkspaceIdentifier(identifier);

    const row = await this.db
      .prepare("SELECT * FROM workspaces WHERE (id = ? OR key = ?) AND status = 'active'")
      .bind(normalized, normalized)
      .first<WorkspaceRow>();

    if (row) return toWorkspace(row);
    return normalized === DEFAULT_WORKSPACE_ID ? defaultWorkspace() : null;
  }

  async listRepositoryRows(workspaceId: string): Promise<WorkspaceRepository[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM workspace_repositories
         WHERE workspace_id = ? AND active = 1
         ORDER BY repo_owner ASC, repo_name ASC`
      )
      .bind(workspaceId)
      .all<WorkspaceRepositoryRow>();

    return (result.results ?? []).map(toWorkspaceRepository);
  }

  async hasExplicitRepositories(workspaceId: string): Promise<boolean> {
    const result = await this.db
      .prepare("SELECT COUNT(*) as count FROM workspace_repositories WHERE workspace_id = ?")
      .bind(workspaceId)
      .first<{ count: number }>();

    return (result?.count ?? 0) > 0;
  }

  async validateRepositoryAccess(params: {
    workspaceId?: string | null;
    provider: string;
    repoOwner: string;
    repoName: string;
  }): Promise<WorkspaceRepositoryAccessResult> {
    const workspace = await this.resolveWorkspace(params.workspaceId);
    if (!workspace) {
      return { ok: false, status: 404, message: "Workspace not found" };
    }

    const rows = await this.listRepositoryRows(workspace.id);
    const hasExplicitRows = rows.length > 0 || (await this.hasExplicitRepositories(workspace.id));

    if (!hasExplicitRows && workspace.id === DEFAULT_WORKSPACE_ID) {
      return { ok: true, status: 200, message: "OK", workspaceId: workspace.id };
    }

    const owner = normalizeRepoPart(params.repoOwner);
    const name = normalizeRepoPart(params.repoName);
    const provider = params.provider.trim().toLowerCase();
    const match = rows.find(
      (row) =>
        row.provider.toLowerCase() === provider &&
        row.repoOwner === owner &&
        row.repoName === name &&
        row.role === "execution"
    );

    if (!match) {
      return {
        ok: false,
        status: 403,
        message: "Repository is not assigned to this workspace",
        workspaceId: workspace.id,
      };
    }

    return { ok: true, status: 200, message: "OK", workspaceId: workspace.id };
  }

  async filterInstalledRepositories<TRepo extends InstallationRepository | EnrichedRepository>(
    workspaceId: string | null | undefined,
    provider: string,
    repos: TRepo[]
  ): Promise<{ workspace: Workspace; repos: Array<TRepo & { workspaceId: string }> }> {
    const workspace = await this.resolveWorkspace(workspaceId);
    if (!workspace) {
      throw new Error("Workspace not found");
    }

    const rows = await this.listRepositoryRows(workspace.id);
    const hasExplicitRows = rows.length > 0 || (await this.hasExplicitRepositories(workspace.id));
    if (!hasExplicitRows && workspace.id === DEFAULT_WORKSPACE_ID) {
      return {
        workspace,
        repos: repos.map((repo) => ({ ...repo, workspaceId: workspace.id })),
      };
    }

    const providerKey = provider.trim().toLowerCase();
    const allowed = new Set(
      rows
        .filter((row) => row.provider.toLowerCase() === providerKey)
        .map((row) => `${row.repoOwner}/${row.repoName}`)
    );

    return {
      workspace,
      repos: repos
        .filter((repo) =>
          allowed.has(`${normalizeRepoPart(repo.owner)}/${normalizeRepoPart(repo.name)}`)
        )
        .map((repo) => ({ ...repo, workspaceId: workspace.id })),
    };
  }
}

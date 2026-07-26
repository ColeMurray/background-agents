import { z } from "zod";
import { fetchWithTimeout, generateAppJwt, type GitHubAppConfig } from "./github-app";

const GITHUB_API_VERSION = "2022-11-28";
const grantedPermissionLevelSchema = z.enum(["read", "write", "admin"]);
const permissionsSchema = z.record(z.string(), grantedPermissionLevelSchema);
const appSchema = z.object({
  id: z.number().int().positive(),
  permissions: permissionsSchema,
});
const installationSchema = z.object({
  id: z.number().int().positive(),
  app_id: z.number().int().positive(),
  permissions: permissionsSchema,
  suspended_at: z.string().nullable(),
});

export type GitHubAppPermissionLevel = "read" | "write";
export type GitHubAppPermissionRequirements = Readonly<Record<string, GitHubAppPermissionLevel>>;
type GitHubAppGrantedPermissionLevel = z.infer<typeof grantedPermissionLevelSchema>;

export interface GitHubAppPermissionOptions {
  readonly requireOrganizationMembers: boolean;
  readonly requireIssues: boolean;
}

export interface GitHubAppPermissionPreflightReport {
  readonly appId: string;
  readonly installationId: string;
  readonly permissions: GitHubAppPermissionRequirements;
}

export interface GitHubAppPermissionPreflightDependencies {
  readonly fetcher: (url: string, init: RequestInit) => Promise<Response>;
  readonly generateAppJwt: (appId: string, privateKey: string) => Promise<string>;
}

const defaultDependencies: GitHubAppPermissionPreflightDependencies = {
  fetcher: (url, init) => fetchWithTimeout(url, init),
  generateAppJwt,
};

export class GitHubAppPermissionPreflightError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GitHubAppPermissionPreflightError";
  }
}

export function buildGitHubAppPermissionRequirements(
  options: GitHubAppPermissionOptions
): GitHubAppPermissionRequirements {
  return {
    contents: "write",
    pull_requests: "write",
    metadata: "read",
    email_addresses: "read",
    ...(options.requireIssues ? { issues: "write" as const } : {}),
    ...(options.requireOrganizationMembers ? { members: "read" as const } : {}),
  };
}

function permissionSatisfies(
  actual: GitHubAppGrantedPermissionLevel | undefined,
  required: GitHubAppPermissionLevel
): boolean {
  return actual === "admin" || actual === "write" || actual === required;
}

async function fetchJson(
  url: string,
  jwt: string,
  fetcher: GitHubAppPermissionPreflightDependencies["fetcher"]
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        "User-Agent": "Open-Inspect-Control-Plane",
      },
    });
  } catch (cause) {
    throw new GitHubAppPermissionPreflightError("GitHub permission preflight request failed", {
      cause,
    });
  }
  if (!response.ok) {
    throw new GitHubAppPermissionPreflightError(
      `GitHub permission preflight request failed with HTTP ${response.status}`
    );
  }
  try {
    return await response.json();
  } catch (cause) {
    throw new GitHubAppPermissionPreflightError(
      "GitHub permission preflight returned invalid JSON",
      { cause }
    );
  }
}

function assertPermissions(
  boundary: "registration" | "installation",
  actual: Record<string, GitHubAppGrantedPermissionLevel>,
  requirements: GitHubAppPermissionRequirements
): void {
  for (const [permission, required] of Object.entries(requirements)) {
    if (!permissionSatisfies(actual[permission], required)) {
      throw new GitHubAppPermissionPreflightError(
        `GitHub App ${boundary} permission ${permission} must be ${required}`
      );
    }
  }
}

export async function preflightGitHubAppPermissions(
  config: GitHubAppConfig,
  options: GitHubAppPermissionOptions,
  dependencies: GitHubAppPermissionPreflightDependencies = defaultDependencies
): Promise<GitHubAppPermissionPreflightReport> {
  const requirements = buildGitHubAppPermissionRequirements(options);
  let jwt: string;
  try {
    jwt = await dependencies.generateAppJwt(config.appId, config.privateKey);
  } catch (cause) {
    throw new GitHubAppPermissionPreflightError(
      "GitHub App authentication failed during permission preflight",
      { cause }
    );
  }
  const appResult = appSchema.safeParse(
    await fetchJson("https://api.github.com/app", jwt, dependencies.fetcher)
  );
  if (!appResult.success || String(appResult.data.id) !== config.appId) {
    throw new GitHubAppPermissionPreflightError(
      "GitHub App registration response does not match GITHUB_APP_ID"
    );
  }
  assertPermissions("registration", appResult.data.permissions, requirements);

  const installationResult = installationSchema.safeParse(
    await fetchJson(
      `https://api.github.com/app/installations/${encodeURIComponent(config.installationId)}`,
      jwt,
      dependencies.fetcher
    )
  );
  if (
    !installationResult.success ||
    String(installationResult.data.id) !== config.installationId ||
    String(installationResult.data.app_id) !== config.appId
  ) {
    throw new GitHubAppPermissionPreflightError(
      "GitHub App installation response does not match the configured app and installation"
    );
  }
  if (installationResult.data.suspended_at !== null) {
    throw new GitHubAppPermissionPreflightError("GitHub App installation is suspended");
  }
  assertPermissions("installation", installationResult.data.permissions, requirements);

  return {
    appId: config.appId,
    installationId: config.installationId,
    permissions: requirements,
  };
}

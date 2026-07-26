import { describe, expect, it, vi } from "vitest";
import {
  GitHubAppPermissionPreflightError,
  buildGitHubAppPermissionRequirements,
  preflightGitHubAppPermissions,
} from "./github-app-permission-preflight";

const config = {
  appId: "123",
  installationId: "456",
  privateKey: "private",
};

describe("GitHub App permission preflight", () => {
  it("checks both registered and installation-approved permissions", async () => {
    const permissions = {
      contents: "write",
      pull_requests: "write",
      metadata: "read",
      members: "read",
      email_addresses: "read",
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ id: 123, permissions }))
      .mockResolvedValueOnce(
        Response.json({
          id: 456,
          app_id: 123,
          permissions,
          suspended_at: null,
        })
      );
    const requirements = buildGitHubAppPermissionRequirements({
      requireOrganizationMembers: true,
      requireIssues: false,
    });

    await expect(
      preflightGitHubAppPermissions(
        config,
        {
          requireOrganizationMembers: true,
          requireIssues: false,
        },
        {
          fetcher,
          generateAppJwt: vi.fn(async () => "app-jwt"),
        }
      )
    ).resolves.toEqual({
      appId: "123",
      installationId: "456",
      permissions: requirements,
    });
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "https://api.github.com/app",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer app-jwt" }),
      })
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "https://api.github.com/app/installations/456",
      expect.any(Object)
    );
  });

  it("ignores unrelated permissions with other GitHub access levels", async () => {
    const permissions = {
      contents: "write",
      pull_requests: "write",
      metadata: "read",
      email_addresses: "read",
      organization_projects: "admin",
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ id: 123, permissions }))
      .mockResolvedValueOnce(
        Response.json({
          id: 456,
          app_id: 123,
          permissions,
          suspended_at: null,
        })
      );

    await expect(
      preflightGitHubAppPermissions(
        config,
        {
          requireOrganizationMembers: false,
          requireIssues: false,
        },
        {
          fetcher,
          generateAppJwt: vi.fn(async () => "app-jwt"),
        }
      )
    ).resolves.toEqual({
      appId: "123",
      installationId: "456",
      permissions: buildGitHubAppPermissionRequirements({
        requireOrganizationMembers: false,
        requireIssues: false,
      }),
    });
  });

  it("always requires access to the provider email evidence used by sign-in", () => {
    expect(
      buildGitHubAppPermissionRequirements({
        requireOrganizationMembers: false,
        requireIssues: false,
      })
    ).toMatchObject({ email_addresses: "read" });
  });

  it("wraps transport failures in the preflight error boundary", async () => {
    await expect(
      preflightGitHubAppPermissions(
        config,
        {
          requireOrganizationMembers: false,
          requireIssues: false,
        },
        {
          fetcher: vi.fn(async () => {
            throw new TypeError("network down");
          }),
          generateAppJwt: vi.fn(async () => "app-jwt"),
        }
      )
    ).rejects.toBeInstanceOf(GitHubAppPermissionPreflightError);
  });

  it("wraps GitHub App authentication failures in the preflight error boundary", async () => {
    await expect(
      preflightGitHubAppPermissions(
        config,
        {
          requireOrganizationMembers: false,
          requireIssues: false,
        },
        {
          fetcher: vi.fn(),
          generateAppJwt: vi.fn(async () => {
            throw new Error("invalid private key");
          }),
        }
      )
    ).rejects.toBeInstanceOf(GitHubAppPermissionPreflightError);
  });

  it("rejects permissions that were registered but not approved on the installation", async () => {
    const registeredPermissions = {
      contents: "write",
      pull_requests: "write",
      metadata: "read",
      email_addresses: "read",
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ id: 123, permissions: registeredPermissions }))
      .mockResolvedValueOnce(
        Response.json({
          id: 456,
          app_id: 123,
          permissions: {
            contents: "write",
            pull_requests: "write",
            metadata: "read",
          },
          suspended_at: null,
        })
      );

    await expect(
      preflightGitHubAppPermissions(
        config,
        {
          requireOrganizationMembers: false,
          requireIssues: false,
        },
        {
          fetcher,
          generateAppJwt: vi.fn(async () => "app-jwt"),
        }
      )
    ).rejects.toEqual(
      expect.objectContaining({
        name: "GitHubAppPermissionPreflightError",
        message: "GitHub App installation permission email_addresses must be read",
      })
    );
  });

  it("rejects a suspended installation", async () => {
    const permissions = {
      contents: "write",
      pull_requests: "write",
      metadata: "read",
      email_addresses: "read",
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ id: 123, permissions }))
      .mockResolvedValueOnce(
        Response.json({
          id: 456,
          app_id: 123,
          permissions,
          suspended_at: "2026-07-25T00:00:00Z",
        })
      );

    await expect(
      preflightGitHubAppPermissions(
        config,
        {
          requireOrganizationMembers: false,
          requireIssues: false,
        },
        {
          fetcher,
          generateAppJwt: vi.fn(async () => "app-jwt"),
        }
      )
    ).rejects.toEqual(
      expect.objectContaining({
        message: "GitHub App installation is suspended",
      })
    );
  });

  it("rejects an installation belonging to a different app", async () => {
    const permissions = {
      contents: "write",
      pull_requests: "write",
      metadata: "read",
      email_addresses: "read",
    };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ id: 123, permissions }))
      .mockResolvedValueOnce(
        Response.json({
          id: 456,
          app_id: 999,
          permissions,
          suspended_at: null,
        })
      );

    await expect(
      preflightGitHubAppPermissions(
        config,
        {
          requireOrganizationMembers: false,
          requireIssues: false,
        },
        {
          fetcher,
          generateAppJwt: vi.fn(async () => "app-jwt"),
        }
      )
    ).rejects.toEqual(
      expect.objectContaining({
        message:
          "GitHub App installation response does not match the configured app and installation",
      })
    );
  });

  it("requires issues write only when GitHub bot behavior is enabled", () => {
    expect(
      buildGitHubAppPermissionRequirements({
        requireOrganizationMembers: false,
        requireIssues: true,
      })
    ).toMatchObject({ issues: "write" });
    expect(
      buildGitHubAppPermissionRequirements({
        requireOrganizationMembers: false,
        requireIssues: false,
      })
    ).not.toHaveProperty("issues");
  });
});

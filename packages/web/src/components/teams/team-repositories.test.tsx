// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamRepositoryGrant } from "@open-inspect/shared/types/teams";
import type { TeamResponse } from "@/hooks/use-teams";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { TeamRepositories } from "./team-repositories";

expect.extend(matchers);

beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

async function chooseOption(combobox: string, option: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: combobox }));
  await user.click(await screen.findByRole("option", { name: option }));
}
const mocks = vi.hoisted(() => ({
  repos: vi.fn(),
  authStatus: "authenticated" as "authenticated" | "loading" | "unauthenticated",
  grants: [] as TeamRepositoryGrant[],
}));
vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: vi.fn() }));
vi.mock("@/lib/auth-session", () => ({
  useAuthSession: () => ({
    data: mocks.authStatus === "authenticated" ? { user: { id: "user-1" } } : null,
    status: mocks.authStatus,
  }),
}));
vi.mock("@/hooks/use-repos", () => ({ useRepos: mocks.repos }));

const denied = {
  canJoin: false,
  canLeave: false,
  canEditMetadata: false,
  canManageMembers: false,
  canManageRepositories: false,
  canManageBindings: false,
  canManageAutomations: false,
  canManageEnvironments: false,
  canManageSecrets: false,
  canArchive: false,
};
const team: TeamResponse = {
  id: "team/one",
  slug: "design",
  name: "Design",
  description: null,
  joinPolicy: "invite_only",
  defaultVisibility: "team",
  defaultEnvironmentId: null,
  grantsVersion: 0,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
  memberCount: 1,
  capabilities: { ...denied, canManageRepositories: true },
};
const namedGrant: TeamRepositoryGrant = {
  id: "grant/one",
  teamId: team.id,
  kind: "repository",
  repoExternalId: 42,
  owner: "group/subgroup",
  name: "api",
  createdAt: 1,
};
const installationGrant: TeamRepositoryGrant = {
  id: "grant-installation",
  teamId: team.id,
  kind: "installation",
  repoExternalId: null,
  owner: null,
  name: null,
  createdAt: 1,
};
const catalog = [
  {
    id: 42,
    fullName: "group/subgroup/api",
    owner: "group/subgroup",
    name: "api",
    description: null,
    private: true,
    defaultBranch: "main",
  },
  {
    id: 43,
    fullName: "acme/web",
    owner: "acme",
    name: "web",
    description: null,
    private: false,
    defaultBranch: "main",
  },
];

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SWRConfig
      value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}
    >
      {children}
    </SWRConfig>
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.grants = [];
  mocks.authStatus = "authenticated";
  mocks.repos.mockReturnValue({ repos: catalog, loading: false, error: undefined });
  vi.mocked(browserApiFetch).mockImplementation(async (_path, init) => {
    if (init?.method === "PUT") {
      const input = JSON.parse(String(init.body));
      const grant = input.kind === "installation" ? installationGrant : namedGrant;
      mocks.grants = [...mocks.grants, grant];
      return Response.json({ grant });
    }
    if (init?.method === "DELETE") {
      mocks.grants = [];
      return new Response(null, { status: 204 });
    }
    return Response.json({ grants: mocks.grants });
  });
});
afterEach(cleanup);

describe("Team repository grants", () => {
  it.each([undefined, denied, { canManageRepositories: true }])(
    "shows members the list without inferring management from %j",
    async (capabilities) => {
      mocks.grants = [namedGrant];
      render(<TeamRepositories team={{ ...team, capabilities }} />, { wrapper });
      expect(await screen.findByText("group/subgroup/api")).toBeInTheDocument();
      expect(screen.getByText("Named repository grant")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Remove/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Add grant" })).not.toBeInTheDocument();
      expect(mocks.repos).toHaveBeenCalledWith(false);
    }
  );

  it("adds a named grant from the full unscoped installation catalog", async () => {
    render(<TeamRepositories team={team} />, { wrapper });
    await screen.findByText("This team has no repository grants.");
    expect(mocks.repos).toHaveBeenCalledWith(true);
    await chooseOption("Repository", "group/subgroup/api");
    fireEvent.click(screen.getByRole("button", { name: "Add grant" }));
    await waitFor(() =>
      expect(browserApiFetch).toHaveBeenCalledWith(
        "/api/teams/team%2Fone/repository-grants",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({
            kind: "repository",
            repoExternalId: 42,
            owner: "group/subgroup",
            name: "api",
          }),
        })
      )
    );
    expect(await screen.findByText("Named repository grant")).toBeInTheDocument();
    // Existing grants lock the scope until removed.
    expect(screen.getByRole("combobox", { name: "Grant scope" })).toBeDisabled();
    await userEvent.setup().click(screen.getByRole("combobox", { name: "Repository" }));
    expect(await screen.findByRole("option", { name: "acme/web" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "group/subgroup/api" })).not.toBeInTheDocument();
  });

  it("adds installation-wide access and disables mixing named grants", async () => {
    render(<TeamRepositories team={team} />, { wrapper });
    await screen.findByText("This team has no repository grants.");
    await chooseOption("Grant scope", "All installation repositories");
    fireEvent.click(screen.getByRole("button", { name: "Add grant" }));
    await waitFor(() =>
      expect(browserApiFetch).toHaveBeenCalledWith(
        "/api/teams/team%2Fone/repository-grants",
        expect.objectContaining({ method: "PUT", body: JSON.stringify({ kind: "installation" }) })
      )
    );
    expect(await screen.findByText("Installation-wide grant")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Grant scope" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Grant scope" })).toHaveTextContent(
      "All installation repositories"
    );
    expect(screen.queryByRole("combobox", { name: "Repository" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add grant" })).toBeDisabled();
  });

  it("removes a grant using encoded IDs and accepts a bodyless 204", async () => {
    mocks.grants = [namedGrant];
    render(<TeamRepositories team={team} />, { wrapper });
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove grant for group/subgroup/api" })
    );
    expect(await screen.findByText("This team has no repository grants.")).toBeInTheDocument();
    expect(browserApiFetch).toHaveBeenCalledWith(
      "/api/teams/team%2Fone/repository-grants/grant%2Fone",
      { method: "DELETE" }
    );
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Grant scope" })).toBeEnabled()
    );
    await userEvent.setup().click(screen.getByRole("combobox", { name: "Grant scope" }));
    expect(
      await screen.findByRole("option", { name: "All installation repositories" })
    ).not.toHaveAttribute("aria-disabled");
  });

  it("treats an already-absent grant as removed and revalidates the list", async () => {
    mocks.grants = [namedGrant];
    vi.mocked(browserApiFetch).mockImplementation(async (_path, init) => {
      if (init?.method === "DELETE") {
        mocks.grants = [];
        return Response.json({ error: "Repository grant not found" }, { status: 404 });
      }
      return Response.json({ grants: mocks.grants });
    });
    render(<TeamRepositories team={team} />, { wrapper });
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove grant for group/subgroup/api" })
    );
    expect(await screen.findByText("This team has no repository grants.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(
        vi
          .mocked(browserApiFetch)
          .mock.calls.filter(([, init]) => !init?.method || init.method === "GET")
      ).toHaveLength(2)
    );
  });

  it.each([
    [404, "Team not found"],
    [403, "Repository grant not found"],
    [500, "Repository grant not found"],
  ] as const)("keeps grants and errors for DELETE %s %s", async (status, error) => {
    mocks.grants = [namedGrant];
    render(<TeamRepositories team={team} />, { wrapper });
    await screen.findByText("Named repository grant");
    vi.mocked(browserApiFetch).mockResolvedValueOnce(Response.json({ error }, { status }));
    fireEvent.click(screen.getByRole("button", { name: "Remove grant for group/subgroup/api" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(error);
    expect(screen.getByText("Named repository grant")).toBeInTheDocument();
  });

  it("does not treat an already-absent grant response as a successful addition", async () => {
    render(<TeamRepositories team={team} />, { wrapper });
    await screen.findByText("This team has no repository grants.");
    await chooseOption("Repository", "group/subgroup/api");
    vi.mocked(browserApiFetch).mockResolvedValueOnce(
      Response.json({ error: "Repository grant not found" }, { status: 404 })
    );
    fireEvent.click(screen.getByRole("button", { name: "Add grant" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Repository grant not found");
    expect(screen.getByText("This team has no repository grants.")).toBeInTheDocument();
  });

  it("keeps archived grants readable but disables every mutation", async () => {
    mocks.grants = [namedGrant];
    render(<TeamRepositories team={{ ...team, archivedAt: 2 }} />, { wrapper });
    expect(await screen.findByText("Named repository grant")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Remove grant for group/subgroup/api" })
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add grant" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Grant scope" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Repository" })).toBeDisabled();
    expect(mocks.repos).toHaveBeenCalledWith(false);
  });

  it("withholds add controls while the grant list loads", () => {
    vi.mocked(browserApiFetch).mockReturnValue(new Promise(() => {}));
    render(<TeamRepositories team={team} />, { wrapper });
    expect(screen.getByRole("status")).toHaveTextContent("Loading repository grants...");
    expect(screen.getByRole("button", { name: "Add grant" })).toBeDisabled();
  });

  it("waits for authentication instead of presenting an authoritative empty list", () => {
    mocks.authStatus = "loading";
    render(<TeamRepositories team={team} />, { wrapper });
    expect(screen.getByRole("status")).toHaveTextContent("Loading repository grants...");
    expect(screen.queryByText("This team has no repository grants.")).not.toBeInTheDocument();
    expect(browserApiFetch).not.toHaveBeenCalled();
  });

  it("rejects malformed grant responses rather than showing grants or enabling mutations", async () => {
    vi.mocked(browserApiFetch).mockResolvedValue(
      Response.json({ grants: [{ kind: "repository" }] })
    );
    render(<TeamRepositories team={team} />, { wrapper });
    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to load repository grants.");
    expect(screen.queryByText("This team has no repository grants.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add grant" })).toBeDisabled();
  });

  it("shows grant-list errors with retry instead of treating them as zero grants", async () => {
    vi.mocked(browserApiFetch).mockResolvedValueOnce(
      Response.json({ error: "Forbidden" }, { status: 403 })
    );
    render(<TeamRepositories team={team} />, { wrapper });
    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to load repository grants.");
    expect(screen.queryByText("This team has no repository grants.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add grant" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("This team has no repository grants.")).toBeInTheDocument();
  });

  it.each(["loading", "error"])(
    "disables named additions while the installation catalog is %s",
    async (state) => {
      mocks.repos.mockReturnValue({
        repos: [],
        loading: state === "loading",
        error: state === "error" ? new Error("Unavailable") : undefined,
      });
      render(<TeamRepositories team={team} />, { wrapper });
      await screen.findByText("This team has no repository grants.");
      expect(screen.getByRole("combobox", { name: "Repository" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Add grant" })).toBeDisabled();
      expect(
        screen.getByText(
          state === "loading"
            ? "Loading installation repositories..."
            : "Unable to load installation repositories."
        )
      ).toBeInTheDocument();
    }
  );

  it("surfaces server conflict codes and retains existing grants on a failed removal", async () => {
    mocks.grants = [namedGrant];
    render(<TeamRepositories team={team} />, { wrapper });
    await screen.findByText("Named repository grant");
    vi.mocked(browserApiFetch).mockResolvedValueOnce(
      Response.json({ error: "Team archived", code: "team_archived" }, { status: 409 })
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove grant for group/subgroup/api" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Team archived (team_archived)");
    expect(screen.getByText("Named repository grant")).toBeInTheDocument();
  });

  it("removes management controls when fresh server capabilities are revoked", async () => {
    mocks.grants = [namedGrant];
    const view = render(<TeamRepositories team={team} />, { wrapper });
    await screen.findByRole("button", { name: "Remove grant for group/subgroup/api" });
    view.rerender(<TeamRepositories team={{ ...team, capabilities: denied }} />);
    expect(screen.getByText("Named repository grant")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remove/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add grant" })).not.toBeInTheDocument();
    expect(mocks.repos).toHaveBeenLastCalledWith(false);
  });
});

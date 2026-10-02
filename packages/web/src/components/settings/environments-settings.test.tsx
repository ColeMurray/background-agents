// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { Environment } from "@open-inspect/shared/types/environments";
import { EnvironmentsSettings } from "./environments-settings";
import { TeamEnvironments } from "@/components/teams/team-environments";

expect.extend(matchers);
afterEach(cleanup);
const mocks = vi.hoisted(() => ({
  environments: [] as Environment[],
  permissions: [] as string[],
  useEnvironments: vi.fn(),
  fetch: vi.fn(),
  mutate: vi.fn(),
  imagesSupported: false,
  canEditMetadata: false,
  canManageBindings: false,
}));
vi.mock("swr", () => ({ useSWRConfig: () => ({ mutate: mocks.mutate }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));
vi.mock("@/lib/browser-api-fetch", () => ({ browserApiFetch: mocks.fetch }));
vi.mock("@/hooks/use-environments", () => ({
  ENVIRONMENTS_KEY: "/api/environments",
  useEnvironments: (scope?: { ownerTeamId?: string }) => {
    mocks.useEnvironments(scope);
    return { environments: mocks.environments, loading: false };
  },
}));
vi.mock("@/hooks/use-image-builds", () => ({ useImageBuilds: () => ({}) }));
vi.mock("@/lib/sandbox-provider", () => ({ supportsRepoImages: () => mocks.imagesSupported }));
vi.mock("@/hooks/use-teams", () => ({ useTeam: () => ({ team: undefined }) }));
vi.mock("@/hooks/use-team-capabilities", () => ({ useTeamCapabilities: () => mocks }));
vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({
    hasPermission: (permission: string) => mocks.permissions.includes(permission),
  }),
}));
vi.mock("./environment-form", () => ({
  EnvironmentForm: ({
    onSubmit,
    mode,
  }: {
    onSubmit: (values: object) => void;
    mode: "create" | "edit";
  }) => (
    <button
      onClick={() =>
        onSubmit({
          name: "Stack",
          ...(mode === "create" ? { teamId: "team-1" } : {}),
          repositories: [{ repoOwner: "acme", repoName: "app" }],
        })
      }
    >
      Save environment
    </button>
  ),
}));
vi.mock("./environment-integration-settings", () => ({
  EnvironmentIntegrationSettings: ({ canManage }: { canManage: boolean }) => (
    <div>
      <p>Overrides editor</p>
      <button disabled={!canManage}>Save overrides</button>
    </div>
  ),
}));
vi.mock("./environment-secrets-import", () => ({
  EnvironmentSecretsImport: () => <p>Import repository secrets</p>,
}));
vi.mock("@/components/secrets-editor", () => ({
  SecretsEditor: ({ disabled }: { disabled: boolean }) => (
    <div>
      <p>Secrets editor</p>
      <button disabled={disabled}>Save secrets</button>
    </div>
  ),
}));

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.permissions = [];
  mocks.imagesSupported = false;
  mocks.canEditMetadata = false;
  mocks.canManageBindings = false;
  mocks.environments = [
    {
      id: "env-1",
      name: "Stack",
      ownerTeamId: "team-1",
      description: null,
      prebuildEnabled: false,
      repositories: [],
      createdAt: 1,
      updatedAt: 1,
    },
  ];
  mocks.fetch.mockResolvedValue(Response.json({}));
  mocks.mutate.mockResolvedValue(undefined);
});

it("uses the exact team list and row capabilities, not global manage", () => {
  mocks.permissions = ["environments.manage"];
  render(<EnvironmentsSettings teamId="team-1" />);
  expect(mocks.useEnvironments).toHaveBeenCalledWith({ ownerTeamId: "team-1" });
  expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
});

it("requires metadata and environment grants, not bindings, for team creation", () => {
  mocks.permissions = ["environments.manage"];
  mocks.canManageBindings = true;
  const view = render(<TeamEnvironments teamId="team/one" />);
  expect(mocks.useEnvironments).toHaveBeenCalledWith({ ownerTeamId: "team/one" });
  expect(screen.queryByRole("button", { name: "New environment" })).not.toBeInTheDocument();
  mocks.canManageBindings = false;
  mocks.canEditMetadata = true;
  view.rerender(<TeamEnvironments teamId="team/one" />);
  expect(screen.getByRole("button", { name: "New environment" })).toBeInTheDocument();
  mocks.permissions = [];
  view.rerender(<TeamEnvironments teamId="team/one" />);
  expect(screen.queryByRole("button", { name: "New environment" })).not.toBeInTheDocument();
});

it("allows row management without global manage and submits only configuration", async () => {
  mocks.environments[0].capabilities = {
    canRead: false,
    canManage: true,
    canUse: false,
  };
  render(<EnvironmentsSettings teamId="team-1" />);
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.click(screen.getByRole("button", { name: "Save environment" }));
  await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(1));
  expect(mocks.fetch.mock.calls.map(([path]) => path)).toEqual(["/api/environments/env-1"]);
  expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toEqual({
    name: "Stack",
    repositories: [{ repoOwner: "acme", repoName: "app" }],
  });
});

it("requires row canManage and image management permission to rebuild", async () => {
  mocks.imagesSupported = true;
  mocks.permissions = ["environments.images.manage"];
  mocks.environments[0].prebuildEnabled = true;
  mocks.environments[0].capabilities = {
    canRead: true,
    canManage: false,
    canUse: true,
  };
  const view = render(<EnvironmentsSettings />);
  expect(screen.queryByTitle("Rebuild image")).not.toBeInTheDocument();
  mocks.environments[0].capabilities = {
    canRead: true,
    canManage: true,
    canUse: false,
  };
  view.rerender(<EnvironmentsSettings />);
  fireEvent.click(screen.getByTitle("Rebuild image"));
  await waitFor(() =>
    expect(mocks.fetch).toHaveBeenCalledWith("/api/environments/env-1/images/trigger", {
      method: "POST",
    })
  );
  mocks.permissions = [];
  view.rerender(<EnvironmentsSettings />);
  expect(screen.queryByTitle("Rebuild image")).not.toBeInTheDocument();
});

it("uses row canRead for feature viewing but keeps unmanaged rows read-only", () => {
  mocks.permissions = [
    "environments.secrets.manage",
    "repositories.secrets.manage",
    "integrations.read",
    "environments.settings.manage",
  ];
  const view = render(<EnvironmentsSettings />);
  expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  mocks.environments[0].capabilities = {
    canRead: true,
    canManage: false,
    canUse: false,
  };
  view.rerender(<EnvironmentsSettings />);
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  expect(screen.getByText("Secrets editor")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save secrets" })).toBeDisabled();
  expect(screen.queryByText("Import repository secrets")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^configuration$/i })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /^overrides$/i }));
  expect(screen.getByRole("button", { name: "Save overrides" })).toBeDisabled();
});

it("does not infer viewing permission from canUse", () => {
  mocks.permissions = ["environments.secrets.manage", "integrations.read"];
  mocks.environments[0].capabilities = {
    canRead: false,
    canManage: false,
    canUse: true,
  };
  render(<EnvironmentsSettings />);
  expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
});

it("requires feature permissions alongside row management for overrides and imports", () => {
  mocks.permissions = ["integrations.read"];
  mocks.environments[0].capabilities = {
    canRead: true,
    canManage: true,
    canUse: false,
  };
  const view = render(<EnvironmentsSettings />);
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.click(screen.getByRole("button", { name: /^overrides$/i }));
  expect(screen.getByRole("button", { name: "Save overrides" })).toBeDisabled();
  mocks.permissions = [
    "integrations.read",
    "environments.settings.manage",
    "environments.secrets.manage",
  ];
  view.rerender(<EnvironmentsSettings />);
  expect(screen.getByRole("button", { name: "Save overrides" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: /^secrets$/i }));
  expect(screen.getByRole("button", { name: "Save secrets" })).toBeEnabled();
  expect(screen.queryByText("Import repository secrets")).not.toBeInTheDocument();
  mocks.permissions.push("repositories.secrets.manage");
  view.rerender(<EnvironmentsSettings />);
  expect(screen.getByText("Import repository secrets")).toBeInTheDocument();
});

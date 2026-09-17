// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecretsSettings } from "./secrets-settings";

expect.extend(matchers);

Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
  configurable: true,
  value: vi.fn(),
});

const mocks = vi.hoisted(() => ({
  permissions: new Set<string>(),
  useRepos: vi.fn(),
}));

vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({
    hasPermission: (permission: string) => mocks.permissions.has(permission),
  }),
}));
vi.mock("@/hooks/use-repos", () => ({ useRepos: mocks.useRepos }));
vi.mock("@/components/secrets-editor", () => ({
  SecretsEditor: ({ scope, owner, name }: { scope: string; owner?: string; name?: string }) => (
    <div>{`${scope} secrets editor${owner && name ? ` for ${owner}/${name}` : ""}`}</div>
  ),
}));

afterEach(() => {
  cleanup();
  mocks.permissions = new Set();
  mocks.useRepos.mockReset();
});

describe("SecretsSettings", () => {
  it("keeps the existing global default for users with both permissions", () => {
    mocks.permissions = new Set([
      "global_secrets.manage",
      "repositories.secrets.manage",
      "repositories.read",
    ]);
    mocks.useRepos.mockReturnValue({ repos: [], loading: false });

    render(<SecretsSettings />);

    expect(mocks.useRepos).toHaveBeenCalledWith(true);
    expect(screen.getByText("global secrets editor")).toBeInTheDocument();
    expect(screen.getByText("All Repositories (Global)")).toBeInTheDocument();
  });

  it("does not fetch repositories or mount a repo editor for global-only users", () => {
    mocks.permissions = new Set(["global_secrets.manage"]);
    mocks.useRepos.mockReturnValue({ repos: [], loading: false });

    render(<SecretsSettings />);

    expect(mocks.useRepos).toHaveBeenCalledWith(false);
    expect(screen.getByText("global secrets editor")).toBeInTheDocument();
    expect(screen.queryByText("repo secrets editor")).not.toBeInTheDocument();
  });

  it("lets authorized repository managers select a repository", async () => {
    const user = userEvent.setup();
    mocks.permissions = new Set(["repositories.secrets.manage", "repositories.read"]);
    mocks.useRepos.mockReturnValue({
      repos: [
        {
          id: 1,
          fullName: "open-inspect/background-agents",
          owner: "open-inspect",
          name: "background-agents",
          description: null,
          private: true,
          defaultBranch: "main",
        },
      ],
      loading: false,
    });

    render(<SecretsSettings />);

    expect(mocks.useRepos).toHaveBeenCalledWith(true);
    expect(screen.getByText("repo secrets editor")).toBeInTheDocument();
    expect(screen.queryByText("global secrets editor")).not.toBeInTheDocument();
    expect(screen.queryByText("All Repositories (Global)")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Repository Select a repository" }));
    await user.click(screen.getByRole("option", { name: /background-agents/ }));

    expect(
      screen.getByText("repo secrets editor for open-inspect/background-agents")
    ).toBeInTheDocument();
  });

  it("does not fetch or offer repository scope without repository read access", () => {
    mocks.permissions = new Set(["repositories.secrets.manage"]);
    mocks.useRepos.mockReturnValue({ repos: [], loading: false });

    render(<SecretsSettings />);

    expect(mocks.useRepos).toHaveBeenCalledWith(false);
    expect(screen.queryByText("repo secrets editor")).not.toBeInTheDocument();
    expect(screen.queryByText("global secrets editor")).not.toBeInTheDocument();
  });
});

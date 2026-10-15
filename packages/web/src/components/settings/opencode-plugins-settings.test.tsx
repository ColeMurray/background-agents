// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { OpencodePluginsSettings } from "./opencode-plugins-settings";

expect.extend(matchers);
const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  remove: vi.fn(),
  mutate: vi.fn(),
  manage: true,
  readRepositories: true,
  useRepos: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({
    hasPermission: (permission: string) =>
      permission === "repositories.read" ? mocks.readRepositories : mocks.manage,
  }),
}));
vi.mock("@/hooks/use-repos", () => ({
  useRepos: mocks.useRepos,
}));
vi.mock("@/hooks/use-opencode-plugins", () => ({
  useOpencodePlugins: () => ({
    plugins: [
      { id: "audit", revision: 7, spec: "@company/audit@1.2.3", repoScopes: null, enabled: true },
    ],
    loading: false,
    mutate: mocks.mutate,
  }),
  saveOpencodePlugin: mocks.save,
  deleteOpencodePlugin: mocks.remove,
}));
beforeEach(() => {
  mocks.useRepos.mockReturnValue({ repos: [{ fullName: "Group/Subgroup/Repo" }] });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  vi.clearAllMocks();
  mocks.manage = true;
  mocks.readRepositories = true;
});

describe("OpenCode plugin settings", () => {
  it("offers read-only users no mutation controls", () => {
    mocks.manage = false;
    render(<OpencodePluginsSettings />);
    expect(screen.getByText("@company/audit@1.2.3")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });
  it("validates pins, selects repositories and persists the selection", async () => {
    const user = userEvent.setup();
    render(<OpencodePluginsSettings />);
    await user.click(screen.getByRole("button", { name: "Add plugin" }));
    await user.type(screen.getByLabelText("Package and exact version"), "audit@latest");
    await user.click(screen.getByRole("button", { name: "Save plugin" }));
    expect(screen.getByRole("alert")).toHaveTextContent("exact version");
    expect(mocks.save).not.toHaveBeenCalled();
    await user.clear(screen.getByLabelText("Package and exact version"));
    await user.type(screen.getByLabelText("Package and exact version"), "audit@2.0.0");
    await user.click(screen.getByLabelText(/Selected repositories/));
    await user.click(screen.getByLabelText("group/subgroup/repo"));
    await user.click(screen.getByRole("button", { name: "Save plugin" }));
    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith({
        spec: "audit@2.0.0",
        repoScopes: ["group/subgroup/repo"],
        enabled: true,
      })
    );
  });
  it("disables and deletes a plugin", async () => {
    const user = userEvent.setup();
    render(<OpencodePluginsSettings />);
    await user.click(screen.getByRole("switch"));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith({ enabled: false }, "audit"));
    await user.click(screen.getByRole("button", { name: /Delete/ }));
    await waitFor(() => expect(mocks.remove).toHaveBeenCalledWith("audit"));
  });
});

it("lets a plugin manager enter nested repository scopes without repository-read access", async () => {
  mocks.readRepositories = false;
  mocks.useRepos.mockReturnValue({ repos: [] });
  const user = userEvent.setup();
  render(<OpencodePluginsSettings />);
  expect(mocks.useRepos).toHaveBeenCalledWith(false);
  await user.click(screen.getByRole("button", { name: "Add plugin" }));
  await user.type(screen.getByLabelText("Package and exact version"), "audit@1.0.0");
  await user.click(screen.getByLabelText(/Selected repositories/));
  await user.type(screen.getByLabelText("Repository name"), "Group/Subgroup/Service");
  await user.click(screen.getByRole("button", { name: "Add repository" }));
  expect(screen.getByLabelText("group/subgroup/service")).toBeChecked();
  await user.click(screen.getByRole("button", { name: "Save plugin" }));
  await waitFor(() =>
    expect(mocks.save).toHaveBeenCalledWith({
      spec: "audit@1.0.0",
      enabled: true,
      repoScopes: ["group/subgroup/service"],
    })
  );
});

it("includes the revision read by the full editor", async () => {
  const user = userEvent.setup();
  render(<OpencodePluginsSettings />);
  await user.click(screen.getByRole("button", { name: /Edit/ }));
  await user.clear(screen.getByLabelText("Package and exact version"));
  await user.type(screen.getByLabelText("Package and exact version"), "audit@2.0.0");
  await user.click(screen.getByRole("button", { name: "Save plugin" }));
  await waitFor(() =>
    expect(mocks.save).toHaveBeenCalledWith(
      { spec: "audit@2.0.0", enabled: true, repoScopes: null, revision: 7 },
      "audit"
    )
  );
});

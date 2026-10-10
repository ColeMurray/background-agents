// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MemoryDto, MemoryRevision } from "@open-inspect/shared/types/memories";
import { MemoriesSettings, SharedMemoriesSettings } from ".";

const mocks = vi.hoisted(() => ({
  params: new URLSearchParams(),
  mutate: vi.fn(),
  createMemory: vi.fn(),
  reviseMemory: vi.fn(),
  applyMemoryAction: vi.fn(),
  setMemoryPreferences: vi.fn(),
  records: [] as MemoryDto[],
  focused: undefined as MemoryDto | undefined,
  revisions: [] as MemoryRevision[],
  canCreate: true,
  nextOffset: null as number | null,
  collection: vi.fn(),
  canManageOwn: true,
  replace: vi.fn(),
  environments: [] as { id: string; name: string }[],
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => mocks.params,
  usePathname: () => "/settings",
  useRouter: () => ({ replace: mocks.replace }),
}));
vi.mock("@/hooks/use-memories", () => ({
  createMemory: mocks.createMemory,
  reviseMemory: mocks.reviseMemory,
  applyMemoryAction: mocks.applyMemoryAction,
  setMemoryPreferences: mocks.setMemoryPreferences,
  useMemory: () => ({ memory: mocks.focused, mutate: mocks.mutate }),
  useMemories: (...args: unknown[]) => {
    mocks.collection(...args);
    return {
      memories: mocks.records,
      canCreate: mocks.canCreate,
      nextOffset: mocks.nextOffset,
      loading: false,
      mutate: mocks.mutate,
    };
  },
  useMemoryPreferences: () => ({
    preferences: { includePersonalMemories: true },
    loading: false,
    mutate: mocks.mutate,
  }),
  useMemoryRevisions: () => ({ revisions: mocks.revisions, loading: false }),
}));
vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({
    hasPermission: (permission: string) =>
      permission !== "memories.manage_own" || mocks.canManageOwn,
  }),
}));
vi.mock("@/hooks/use-repos", () => ({
  useRepos: () => ({
    repos: [
      { id: 1, owner: "acme", name: "web", fullName: "acme/web" },
      { id: 2, owner: "acme", name: "api", fullName: "acme/api" },
    ],
    loading: false,
  }),
}));
vi.mock("@/hooks/use-environments", () => ({
  useEnvironments: () => ({ environments: mocks.environments, loading: false }),
}));

const record: MemoryDto = {
  id: "mem_a",
  scope: { type: "personal" },
  memoryType: "fact",
  status: "proposed",
  title: "Tests need Docker",
  description: "Start Docker before tests",
  content: "Run docker compose up",
  currentRevisionId: "rev_b",
  revisionNumber: 2,
  authorKind: "agent",
  authorUserId: "owner",
  authorSessionId: "session_a",
  supersedesMemoryId: null,
  supersededByMemoryIds: [],
  approvedAt: null,
  archivedAt: null,
  archiveKind: null,
  archiveNote: null,
  createdAt: 1,
  updatedAt: 1,
  capabilities: { canEdit: true, actions: ["approve", "reject", "archive"] },
};
const firstRevision: MemoryRevision = {
  id: "rev_a",
  memoryId: "mem_a",
  revisionNumber: 1,
  memoryType: "fact",
  title: "Tests need Docker",
  description: "Start Docker before running tests",
  content: "docker compose up -d",
  authorKind: "user",
  authorUserId: "owner",
  authorSessionId: null,
  createdAt: 1,
};

describe("memory management", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    mocks.params = new URLSearchParams();
    mocks.records = [];
    mocks.focused = undefined;
    mocks.revisions = [];
    mocks.canCreate = true;
    mocks.nextOffset = null;
    mocks.canManageOwn = true;
    mocks.environments = [];
    for (const mutation of [mocks.createMemory, mocks.reviseMemory, mocks.applyMemoryAction]) {
      mutation.mockResolvedValue(record);
    }
    mocks.setMemoryPreferences.mockResolvedValue({ includePersonalMemories: false });
  });

  it("shows a deep-linked record with its history even when it is not on the current page", () => {
    mocks.params = new URLSearchParams({ memoryId: record.id });
    mocks.focused = record;
    mocks.revisions = [firstRevision];
    render(<MemoriesSettings />);
    expect(screen.getByText(record.title)).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Proposed" }).getAttribute("aria-checked")).toBe(
      "true"
    );
    expect(screen.getByText(/Revision 1 · User/)).toBeTruthy();
    expect(screen.queryByText(/No proposed memories/)).toBeNull();
  });

  it("navigates pages and resets pagination when the status changes", () => {
    mocks.nextOffset = 50;
    render(<MemoriesSettings />);
    fireEvent.click(screen.getByText("Next page"));
    expect(mocks.collection).toHaveBeenLastCalledWith({ type: "personal" }, "active", 50, "");
    fireEvent.click(screen.getByRole("radio", { name: "Archived" }));
    expect(mocks.collection).toHaveBeenLastCalledWith({ type: "personal" }, "archived", 0, "");
  });

  it("validates a new record and creates it in the collection's scope", async () => {
    render(<MemoriesSettings />);
    fireEvent.click(screen.getByText("New memory"));
    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: "Tests need Docker" } });
    fireEvent.change(screen.getByLabelText(/Description/), { target: { value: "Too short" } });
    fireEvent.change(screen.getByLabelText(/Content/), {
      target: { value: "Run docker compose up" },
    });
    fireEvent.click(screen.getByText("Save memory"));
    expect(mocks.createMemory).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/Description/), {
      target: { value: "Start Docker before tests" },
    });
    fireEvent.click(screen.getByText("Save memory"));
    await waitFor(() => expect(screen.queryByText("Save memory")).toBeNull());
    expect(mocks.createMemory).toHaveBeenCalledWith({
      scope: { type: "personal" },
      memoryType: "fact",
      title: "Tests need Docker",
      description: "Start Docker before tests",
      content: "Run docker compose up",
      supersedesMemoryId: undefined,
    });
  });

  it("applies immediate lifecycle actions to the displayed record", async () => {
    mocks.records = [record];
    render(<MemoriesSettings />);
    fireEvent.click(screen.getByText("Approve"));
    await waitFor(() =>
      expect(mocks.applyMemoryAction).toHaveBeenCalledWith(record, "approve", undefined)
    );
  });

  it("asks for an archive note in a single panel that other panels replace", async () => {
    mocks.records = [record];
    render(<MemoriesSettings />);
    fireEvent.click(screen.getByText("Archive"));
    fireEvent.click(screen.getByText("Edit"));
    expect(screen.queryByText("Confirm archive")).toBeNull();
    expect(screen.getByText("Edit memory")).toBeTruthy();
    fireEvent.click(screen.getByText("Archive"));
    expect(screen.queryByText("Edit memory")).toBeNull();
    fireEvent.change(screen.getByLabelText(/Archive note/), { target: { value: "Outdated" } });
    fireEvent.click(screen.getByText("Confirm archive"));
    await waitFor(() =>
      expect(mocks.applyMemoryAction).toHaveBeenCalledWith(record, "archive", "Outdated")
    );
    await waitFor(() => expect(screen.queryByText("Confirm archive")).toBeNull());
  });

  it("keeps the editor open and reports server errors in one place", async () => {
    mocks.records = [record];
    mocks.reviseMemory.mockRejectedValue(new Error("Memory has changed; reload and retry"));
    render(<MemoriesSettings />);
    fireEvent.click(screen.getByText("Edit"));
    fireEvent.click(screen.getByText("Save memory"));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Memory has changed; reload and retry"
    );
    expect(mocks.reviseMemory).toHaveBeenCalledWith(record, {
      memoryType: "fact",
      title: record.title,
      description: record.description,
      content: record.content,
    });
    expect(screen.getByText("Edit memory")).toBeTruthy();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("restores a revision once and keeps history open", async () => {
    mocks.records = [record];
    mocks.revisions = [firstRevision];
    render(<MemoriesSettings />);
    fireEvent.click(screen.getByText("Revision history"));
    fireEvent.click(screen.getByText("Revert to this revision"));
    await waitFor(() => expect(mocks.reviseMemory).toHaveBeenCalledWith(record, firstRevision));
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Revert to this revision")).toBeTruthy();
  });

  it("renders only the actions and edits the server granted", () => {
    mocks.records = [
      {
        ...record,
        status: "archived",
        archiveKind: "rejected",
        archiveNote: "Wrong repository",
        capabilities: { canEdit: false, actions: ["restore"] },
      },
    ];
    mocks.canCreate = false;
    render(<MemoriesSettings />);
    expect(screen.getByText("Restore")).toBeTruthy();
    expect(screen.getByText("Rejected: Wrong repository")).toBeTruthy();
    for (const label of ["Approve", "Reject", "Archive", "Edit", "Supersede", "New memory"]) {
      expect(screen.queryByText(label)).toBeNull();
    }
  });

  it("saves the default opt-out and explains the shared-session audience", async () => {
    render(<MemoriesSettings />);
    expect(screen.getByText(/may appear in agent responses/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Include my personal memories in new sessions"));
    await waitFor(() =>
      expect(mocks.setMemoryPreferences).toHaveBeenCalledWith({ includePersonalMemories: false })
    );
    expect(mocks.mutate).toHaveBeenCalledWith({ includePersonalMemories: false }, false);
  });

  it("lets a session creator without memory management save the opt-out", async () => {
    mocks.canManageOwn = false;
    render(<MemoriesSettings />);
    expect(mocks.collection).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Include my personal memories in new sessions"));
    await waitFor(() =>
      expect(mocks.setMemoryPreferences).toHaveBeenCalledWith({ includePersonalMemories: false })
    );
  });

  it("opens the shared scope named by a deep link", () => {
    mocks.params = new URLSearchParams({ scope: "repository", repoOwner: "Acme", repoName: "web" });
    render(<SharedMemoriesSettings />);
    expect(mocks.collection).toHaveBeenLastCalledWith(
      { type: "repository", repoOwner: "acme", repoName: "web" },
      "active",
      0,
      ""
    );
  });

  it("filters by a debounced search kept in the URL and returns to the first page", async () => {
    mocks.nextOffset = 50;
    render(<MemoriesSettings />);
    fireEvent.click(screen.getByText("Next page"));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search memories" }), {
      target: { value: "  rspec  " },
    });
    await waitFor(() =>
      expect(mocks.collection).toHaveBeenLastCalledWith({ type: "personal" }, "active", 0, "rspec")
    );
    expect(mocks.replace).toHaveBeenLastCalledWith("/settings?search=rspec", { scroll: false });
    expect(screen.getByText("No active memories match “rspec”.")).toBeTruthy();
  });

  it("returns to the first page when a search is cleared", async () => {
    mocks.nextOffset = 50;
    render(<MemoriesSettings />);
    fireEvent.click(screen.getByText("Next page"));
    expect(mocks.collection).toHaveBeenLastCalledWith({ type: "personal" }, "active", 50, "");
    const box = screen.getByRole("searchbox", { name: "Search memories" });
    fireEvent.change(box, { target: { value: "rspec" } });
    await waitFor(() =>
      expect(mocks.collection).toHaveBeenLastCalledWith({ type: "personal" }, "active", 0, "rspec")
    );
    fireEvent.change(box, { target: { value: "" } });
    await waitFor(() =>
      expect(mocks.collection).toHaveBeenLastCalledWith({ type: "personal" }, "active", 0, "")
    );
  });

  it("follows a search changed by navigation instead of restoring the old one", async () => {
    mocks.params = new URLSearchParams({ search: "docker" });
    const { rerender } = render(<MemoriesSettings />);
    mocks.params = new URLSearchParams({ search: "rspec" });
    rerender(<MemoriesSettings />);
    await waitFor(() =>
      expect(mocks.collection).toHaveBeenLastCalledWith({ type: "personal" }, "active", 0, "rspec")
    );
    expect(
      (screen.getByRole("searchbox", { name: "Search memories" }) as HTMLInputElement).value
    ).toBe("rspec");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("starts from a search already in the URL", () => {
    mocks.params = new URLSearchParams({ search: "docker" });
    render(<MemoriesSettings />);
    expect(mocks.collection).toHaveBeenLastCalledWith({ type: "personal" }, "active", 0, "docker");
    expect(
      (screen.getByRole("searchbox", { name: "Search memories" }) as HTMLInputElement).value
    ).toBe("docker");
  });

  it("narrows the scope picker as you type and opens the chosen scope", async () => {
    mocks.environments = [{ id: "env_taskiq", name: "TaskIQ Factory" }];
    render(<SharedMemoriesSettings />);
    fireEvent.click(screen.getByRole("button", { name: /Memory scope/ }));
    fireEvent.change(screen.getByPlaceholderText("Search repositories and environments..."), {
      target: { value: "taskiq" },
    });
    expect(screen.queryByText("acme/web")).toBeNull();
    fireEvent.click(screen.getByText("TaskIQ Factory"));
    expect(mocks.collection).toHaveBeenLastCalledWith(
      { type: "environment", environmentId: "env_taskiq" },
      "active",
      0,
      ""
    );
  });
});

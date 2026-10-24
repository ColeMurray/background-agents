// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  MEMORY_SHARED_LIST_MAX_OFFSET,
  type MemoryDto,
  type MemoryRevision,
} from "@open-inspect/shared/types/memories";
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
  replaceState: vi.fn(),
  environments: [] as { id: string; name: string }[],
}));
// Like Next, native history writes re-render readers of useSearchParams.
const urlListeners = new Set<() => void>();
vi.mock("next/navigation", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    urlListeners.add(listener);
    return () => urlListeners.delete(listener);
  };
  return {
    useSearchParams: () => useSyncExternalStore(subscribe, () => mocks.params),
  };
});
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

/** Navigate: the address bar and useSearchParams both show the new query. */
function setParams(init: Record<string, string>) {
  mocks.params = new URLSearchParams(init);
  window.history.pushState(null, "", `/settings?${mocks.params}`);
}

describe("memory management", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    mocks.params = new URLSearchParams();
    window.history.pushState(null, "", "/settings");
    const realReplaceState = History.prototype.replaceState;
    vi.spyOn(window.history, "replaceState").mockImplementation((state, unused, href) => {
      realReplaceState.call(window.history, state, unused, href);
      mocks.replaceState(String(href));
      mocks.params = new URLSearchParams(String(href).split("?")[1] ?? "");
      act(() => urlListeners.forEach((listener) => listener()));
    });
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

  it("defaults to all shared memories and reviews proposals from multiple repositories", async () => {
    const first = {
      ...record,
      scope: { type: "repository" as const, repoOwner: "acme", repoName: "web" },
    };
    const second = {
      ...record,
      id: "mem_other",
      title: "Use the API fixtures",
      scope: { type: "repository" as const, repoOwner: "acme", repoName: "api" },
      capabilities: { canEdit: false, actions: [] },
    };
    mocks.records = [first, second];
    render(<SharedMemoriesSettings />);
    expect(screen.getByRole("button", { name: "Memory scope All" })).toBeTruthy();
    expect(mocks.collection).toHaveBeenLastCalledWith("shared", "active", 0, "");
    expect(screen.queryByText("New memory")).toBeNull();
    expect(screen.getByRole("link", { name: "acme/web" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "acme/api" })).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Proposed" }));
    expect(mocks.collection).toHaveBeenLastCalledWith("shared", "proposed", 0, "");
    expect(screen.getAllByRole("button", { name: "Approve" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(mocks.applyMemoryAction).toHaveBeenCalledWith(first, "approve", undefined)
    );
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(2));
  });

  it("returns to All from a repository and resets pagination and status", () => {
    mocks.nextOffset = 50;
    render(<SharedMemoriesSettings />);
    fireEvent.click(screen.getByRole("button", { name: /Memory scope/ }));
    fireEvent.click(screen.getByRole("option", { name: "acme/web" }));
    fireEvent.click(screen.getByText("Next page"));
    expect(mocks.collection).toHaveBeenLastCalledWith(
      { type: "repository", repoOwner: "acme", repoName: "web" },
      "active",
      50,
      ""
    );
    fireEvent.click(screen.getByRole("radio", { name: "Archived" }));
    fireEvent.click(screen.getByRole("button", { name: /Memory scope/ }));
    fireEvent.click(screen.getByRole("option", { name: "All" }));
    expect(mocks.collection).toHaveBeenLastCalledWith("shared", "active", 0, "");
  });

  it("does not include a deep-linked personal memory in All", () => {
    mocks.params = new URLSearchParams({ memoryId: record.id });
    mocks.focused = record;
    render(<SharedMemoriesSettings />);
    expect(screen.queryByText(record.title)).toBeNull();
    expect(screen.getByText(/No proposed memories across your accessible/)).toBeTruthy();
  });

  it("keeps historical repository links in All and loads the focused record by ID", () => {
    const historical = {
      ...record,
      scope: { type: "repository" as const, repoOwner: "old/group", repoName: "reused" },
      supersedesMemoryId: "mem_old",
    };
    setParams({ scope: "shared", tab: "shared-memories", memoryId: historical.id });
    mocks.focused = historical;
    render(<SharedMemoriesSettings />);
    expect(screen.getByRole("button", { name: "Memory scope All" })).toBeTruthy();
    expect(screen.getByText(historical.title)).toBeTruthy();
    expect(screen.getByRole("link", { name: "old/group/reused" }).getAttribute("href")).toBe(
      `/settings?scope=shared&tab=shared-memories&memoryId=${historical.id}`
    );
    expect(screen.getByRole("link", { name: "mem_old" }).getAttribute("href")).toBe(
      "/settings?scope=shared&tab=shared-memories&memoryId=mem_old"
    );
    expect(mocks.collection).toHaveBeenLastCalledWith("shared", "proposed", 0, "");
  });

  it("explains the shared browsing cap and lets search restart from page one", async () => {
    mocks.nextOffset = MEMORY_SHARED_LIST_MAX_OFFSET;
    const { rerender } = render(<SharedMemoriesSettings />);
    fireEvent.click(screen.getByText("Next page"));
    mocks.nextOffset = null;
    rerender(<SharedMemoriesSettings />);
    expect(screen.getByText(/All-view browsing limit reached/)).toBeTruthy();
    expect((screen.getByText("Next page") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search memories" }), {
      target: { value: "docker" },
    });
    await waitFor(() =>
      expect(mocks.collection).toHaveBeenLastCalledWith("shared", "active", 0, "docker")
    );
    expect(screen.queryByText(/All-view browsing limit reached/)).toBeNull();
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
    expect(mocks.replaceState).toHaveBeenLastCalledWith("/settings?search=rspec");
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
    setParams({ search: "docker" });
    const { rerender } = render(<MemoriesSettings />);
    setParams({ search: "rspec" });
    rerender(<MemoriesSettings />);
    await waitFor(() =>
      expect(mocks.collection).toHaveBeenLastCalledWith({ type: "personal" }, "active", 0, "rspec")
    );
    expect(
      (screen.getByRole("searchbox", { name: "Search memories" }) as HTMLInputElement).value
    ).toBe("rspec");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(mocks.replaceState).not.toHaveBeenCalled();
  });

  it("explains a search with too many terms instead of requesting it", async () => {
    render(<MemoriesSettings />);
    const box = screen.getByRole("searchbox", { name: "Search memories" });
    fireEvent.change(box, { target: { value: "rspec" } });
    await waitFor(() =>
      expect(mocks.collection).toHaveBeenLastCalledWith({ type: "personal" }, "active", 0, "rspec")
    );
    fireEvent.change(box, { target: { value: "a1 b2 c3 d4 e5 f6 g7 h8 i9" } });
    expect(await screen.findByText("Use at most 8 search terms.")).toBeTruthy();
    expect(mocks.collection).toHaveBeenLastCalledWith({ type: "personal" }, "active", 0, "rspec");
    expect(mocks.collection).not.toHaveBeenCalledWith(
      { type: "personal" },
      "active",
      0,
      "a1 b2 c3 d4 e5 f6 g7 h8 i9"
    );
  });

  it("does not filter on a single character", async () => {
    render(<MemoriesSettings />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search memories" }), {
      target: { value: "r" },
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(mocks.collection).toHaveBeenLastCalledWith({ type: "personal" }, "active", 0, "");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps a one-character edit after the URL echo", async () => {
    setParams({ search: "rspec" });
    render(<MemoriesSettings />);
    const box = screen.getByRole("searchbox", { name: "Search memories" }) as HTMLInputElement;
    fireEvent.change(box, { target: { value: "r" } });
    await waitFor(() => expect(mocks.replaceState).toHaveBeenLastCalledWith("/settings"));
    expect(box.value).toBe("r");
    expect(mocks.collection).toHaveBeenLastCalledWith({ type: "personal" }, "active", 0, "");
  });

  it("starts from a search already in the URL", () => {
    setParams({ search: "docker" });
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

// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MemoryView } from "@open-inspect/shared/types/memories";
import { MemoriesSettings } from "./memories-settings";

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  mutate: vi.fn(),
  records: [] as MemoryView[],
  canCreate: true,
  nextOffset: null as number | null,
  collection: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("@/hooks/use-memories", () => ({
  memoryRequest: mocks.request,
  useMemory: () => ({ mutate: mocks.mutate }),
  useMemories: (...args: unknown[]) => {
    mocks.collection(...args);
    return {
      data: { memories: mocks.records, canCreate: mocks.canCreate, nextOffset: mocks.nextOffset },
      mutate: mocks.mutate,
    };
  },
  useMemoryPreferences: () => ({ data: { includePersonalMemories: true }, mutate: mocks.mutate }),
  useMemoryRevisions: () => ({ data: { revisions: [] } }),
}));
const record: MemoryView = {
  id: "mem_a",
  scope: { type: "personal" },
  ownerUserId: "owner",
  memoryType: "fact",
  status: "proposed",
  title: "Tests need Docker",
  description: "Start Docker before tests",
  content: "Run docker compose up",
  currentRevisionId: "rev_a",
  revisionNumber: 1,
  authorKind: "agent",
  authorUserId: "owner",
  authorSessionId: "session_a",
  supersedesMemoryId: null,
  approvedAt: null,
  archivedAt: null,
  archiveReason: null,
  createdAt: 1,
  updatedAt: 1,
  capabilities: { canEdit: true, canArchive: true, canApprove: true },
};

describe("memory management", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    mocks.records = [];
    mocks.canCreate = true;
    mocks.nextOffset = null;
    mocks.request.mockResolvedValue({ memory: record });
  });
  it("navigates pages and resets pagination when the status changes", () => {
    mocks.nextOffset = 50;
    render(<MemoriesSettings />);
    fireEvent.click(screen.getByText("Next page"));
    expect(mocks.collection).toHaveBeenLastCalledWith({ type: "personal" }, "active", 50);
    fireEvent.click(screen.getByRole("tab", { name: "Archived" }));
    expect(mocks.collection).toHaveBeenLastCalledWith({ type: "personal" }, "archived", 0);
  });
  it("validates a new record and sends only its selected scope and content", async () => {
    render(<MemoriesSettings />);
    fireEvent.click(screen.getByText("New memory"));
    fireEvent.click(screen.getByText("Save memory"));
    expect(mocks.request).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: "Tests need Docker" } });
    fireEvent.change(screen.getByLabelText(/Description/), {
      target: { value: "Start Docker before tests" },
    });
    fireEvent.change(screen.getByLabelText(/Content/), {
      target: { value: "Run docker compose up" },
    });
    fireEvent.click(screen.getByText("Save memory"));
    await waitFor(() => expect(mocks.request).toHaveBeenCalled());
    expect(JSON.parse(mocks.request.mock.calls[0][2].body)).toEqual({
      scope: { type: "personal" },
      memoryType: "fact",
      title: "Tests need Docker",
      description: "Start Docker before tests",
      content: "Run docker compose up",
    });
  });
  it("approves exactly the revision the owner reviewed", async () => {
    mocks.records = [record];
    render(<MemoriesSettings />);
    fireEvent.click(screen.getByText("Approve"));
    await waitFor(() => expect(mocks.request).toHaveBeenCalled());
    expect(mocks.request.mock.calls[0][0]).toBe("/api/memories/mem_a/approve");
    expect(JSON.parse(mocks.request.mock.calls[0][2].body)).toEqual({
      expectedRevisionId: "rev_a",
    });
  });
  it("does not render write actions without server capabilities", () => {
    mocks.records = [
      { ...record, capabilities: { canEdit: false, canArchive: false, canApprove: false } },
    ];
    mocks.canCreate = false;
    render(<MemoriesSettings />);
    expect(screen.queryByText("Approve")).toBeNull();
    expect(screen.queryByText("Edit")).toBeNull();
    expect(screen.queryByText("New memory")).toBeNull();
  });
  it("saves the default opt-out and explains the shared-session audience", async () => {
    render(<MemoriesSettings />);
    expect(screen.getByText(/may appear in agent responses/)).toBeTruthy();
    fireEvent.click(
      screen.getByLabelText("Include my personal memories in new sessions by default")
    );
    await waitFor(() => expect(mocks.request).toHaveBeenCalled());
    expect(JSON.parse(mocks.request.mock.calls[0][2].body)).toEqual({
      includePersonalMemories: false,
    });
  });
});

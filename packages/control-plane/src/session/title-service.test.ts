import { describe, it, expect, vi } from "vitest";
import { createTestBackgroundTasks } from "../background-tasks.test-support";
import type { SessionIndexStore } from "../db/session-index";
import { SessionTitleService } from "./title-service";
import type { SessionCoreRepository } from "./session-core-repository";
import type { SessionRow } from "./types";

const NOW = 1_700_000_000_000;

function sessionRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "session-1",
    session_name: "public-name",
    parent_session_id: null,
    status: "active",
    updated_at: NOW - 5_000,
    ...overrides,
  } as SessionRow;
}

function makeHarness(options: { session?: SessionRow | null; withoutIndexStore?: boolean } = {}) {
  const session = options.session === undefined ? sessionRow() : options.session;
  const repository = {
    getSession: vi.fn(() => session),
    updateSessionTitle: vi.fn(),
    updateSessionTitleIfUnset: vi.fn(() => true),
  };
  const messenger = { broadcast: vi.fn(), sendToSandbox: vi.fn(async () => {}) };
  const statusService = { notifyParentOfChildUpdate: vi.fn() };
  const backgroundTasks = createTestBackgroundTasks();
  const updateTitleIfNewer = vi.fn(async () => {});
  const service = new SessionTitleService({
    sessionCoreRepository: repository as unknown as SessionCoreRepository,
    messenger,
    statusService,
    backgroundTasks,
    sessionIndexStore: options.withoutIndexStore
      ? null
      : ({ updateTitleIfNewer } as unknown as SessionIndexStore),
    durableObjectId: "do-hex-id",
    now: () => NOW,
  });
  return { service, repository, messenger, statusService, backgroundTasks, updateTitleIfNewer };
}

describe("SessionTitleService", () => {
  it("rejects an invalid title before touching persistence", () => {
    const h = makeHarness();

    const result = h.service.applySessionTitleUpdate("   ");

    expect(result).toEqual({ ok: false, reason: "invalid", error: expect.any(String) });
    expect(h.repository.updateSessionTitle).not.toHaveBeenCalled();
    expect(h.messenger.broadcast).not.toHaveBeenCalled();
  });

  it("returns not_found when the session row does not exist", () => {
    const h = makeHarness({ session: null });

    const result = h.service.applySessionTitleUpdate("A title");

    expect(result).toEqual({ ok: false, reason: "not_found", error: "Session not found" });
    expect(h.repository.updateSessionTitle).not.toHaveBeenCalled();
  });

  it("returns already_set when onlyIfUnset loses to an existing title", () => {
    const h = makeHarness();
    h.repository.updateSessionTitleIfUnset.mockReturnValue(false);

    const result = h.service.applySessionTitleUpdate("A title", { onlyIfUnset: true });

    expect(result).toEqual({
      ok: false,
      reason: "already_set",
      error: "Session title is already set",
    });
    expect(h.repository.updateSessionTitle).not.toHaveBeenCalled();
    expect(h.messenger.broadcast).not.toHaveBeenCalled();
  });

  it("persists, broadcasts, and schedules the index sync on success", async () => {
    const h = makeHarness();

    const result = h.service.applySessionTitleUpdate("  New title  ");

    expect(result).toEqual({ ok: true, title: "New title" });
    expect(h.repository.updateSessionTitle).toHaveBeenCalledWith("session-1", "New title", NOW);
    expect(h.messenger.broadcast).toHaveBeenCalledWith({
      type: "session_title",
      title: "New title",
    });
    expect(h.backgroundTasks.submissions).toEqual([
      expect.objectContaining({ name: "session_index.update_title" }),
    ]);
    await h.backgroundTasks.settle();
    expect(h.backgroundTasks.failures).toEqual([]);
    expect(h.updateTitleIfNewer).toHaveBeenCalledWith("public-name", "New title", NOW);
    expect(h.statusService.notifyParentOfChildUpdate).not.toHaveBeenCalled();
  });

  it("advances updated_at monotonically when the clock is behind the row", () => {
    const h = makeHarness({ session: sessionRow({ updated_at: NOW + 10_000 }) });

    h.service.applySessionTitleUpdate("A title");

    expect(h.repository.updateSessionTitle).toHaveBeenCalledWith(
      "session-1",
      "A title",
      NOW + 10_001
    );
  });

  it("notifies the parent session for child sessions", () => {
    const h = makeHarness({ session: sessionRow({ parent_session_id: "parent-1" }) });

    h.service.applySessionTitleUpdate("Child title");

    expect(h.statusService.notifyParentOfChildUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "session-1", title: "Child title" }),
      "public-name",
      { status: "active", title: "Child title" }
    );
  });

  it("skips the index sync when no D1 store is bound", () => {
    const h = makeHarness({ withoutIndexStore: true });

    const result = h.service.applySessionTitleUpdate("A title");

    expect(result).toEqual({ ok: true, title: "A title" });
    expect(h.backgroundTasks.submissions).toEqual([]);
  });
});

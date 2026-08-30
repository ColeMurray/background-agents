// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { fireEvent, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { expect, it, vi } from "vitest";
import type { SessionItem } from "@/hooks/use-sidebar-sessions";
import { SessionListItem } from "./session-list-item";

expect.extend(matchers);

vi.mock("next/link", () => ({
  default: ({ children, ...props }: React.ComponentProps<"a">) => <a {...props}>{children}</a>,
}));

vi.mock("@/hooks/use-session-rename", () => ({
  useSessionRename: () => ({ optimisticTitle: null, renameSession: vi.fn() }),
}));

function session(canManageLifecycle: boolean): SessionItem {
  return {
    id: "session-1",
    title: "Session one",
    repoOwner: null,
    repoName: null,
    baseBranch: null,
    status: "active",
    parentSessionId: null,
    spawnSource: "user",
    environmentId: null,
    createdAt: 1,
    updatedAt: 2,
    readState: { latestMessageId: null, unread: false },
    canManageLifecycle,
  };
}

function renderItem(canManageLifecycle: boolean) {
  render(
    <SessionListItem
      session={session(canManageLifecycle)}
      isActive={false}
      isMobile={false}
      onArchive={vi.fn()}
      onMarkLatestMessageRead={vi.fn()}
    />
  );
}

it("hides rename and archive actions without row lifecycle capability", () => {
  renderItem(false);

  expect(screen.queryByRole("button", { name: "Session actions" })).not.toBeInTheDocument();
});

it("shows rename and archive actions with row lifecycle capability", async () => {
  renderItem(true);

  fireEvent.pointerDown(screen.getByRole("button", { name: "Session actions" }), {
    button: 0,
    ctrlKey: false,
  });

  expect(await screen.findByRole("menuitem", { name: "Rename" })).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: "Archive" })).toBeInTheDocument();
});

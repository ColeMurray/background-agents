// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import {
  USER_MERGE_COUNT_KEYS,
  type MemberMergePreview,
  type UserMergeCountKey,
  type WorkspaceMember,
} from "@open-inspect/shared/rbac";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MergeMembersDialog } from "./merge-members-dialog";

expect.extend(matchers);

vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const MEMBER_ROLE = { id: "role_builtin_member", key: "member" as const, name: "Member" };
const ADMIN_ROLE = {
  id: "role_builtin_administrator",
  key: "administrator" as const,
  name: "Administrator",
};

const admin: WorkspaceMember = {
  userId: "adad0000000000000000000000000000",
  displayName: "Ada",
  email: "ada@example.com",
  suspendedAt: null,
  role: ADMIN_ROLE,
};
const githubSam: WorkspaceMember = {
  userId: "aaaa1111111111111111111111111111",
  displayName: "Sam",
  email: "sam@example.com",
  suspendedAt: null,
  role: MEMBER_ROLE,
};
const slackSam: WorkspaceMember = {
  userId: "bbbb2222222222222222222222222222",
  displayName: "Sam (Slack)",
  email: "sam@corp.example",
  suspendedAt: null,
  role: MEMBER_ROLE,
};

function counts(nonZero: Partial<Record<UserMergeCountKey, number>> = {}) {
  return {
    ...(Object.fromEntries(USER_MERGE_COUNT_KEYS.map((key) => [key, 0])) as Record<
      UserMergeCountKey,
      number
    >),
    ...nonZero,
  };
}

function previewFor(overrides: Partial<MemberMergePreview> = {}): MemberMergePreview {
  return {
    source: {
      member: slackSam,
      identities: [{ provider: "slack", login: null, email: "sam@corp.example" }],
    },
    target: {
      member: githubSam,
      identities: [{ provider: "github", login: "sam-gh", email: null }],
    },
    blocker: null,
    counts: counts({ identitiesRepointed: 1, sessionsRepointed: 3 }),
    ...overrides,
  };
}

function renderDialog(actions: Partial<Parameters<typeof MergeMembersDialog>[0]> = {}) {
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    members: [admin, githubSam, slackSam],
    currentUserId: admin.userId,
    previewMerge: vi.fn().mockResolvedValue(previewFor()),
    mergeMembers: vi.fn().mockResolvedValue({
      sourceUserId: slackSam.userId,
      targetUserId: githubSam.userId,
      counts: counts(),
    }),
    ...actions,
  };
  render(<MergeMembersDialog {...props} />);
  return props;
}

async function chooseAccounts(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("combobox", { name: "Account to keep" }));
  await user.click(await screen.findByRole("option", { name: /^Sam \(sam@example\.com\)/ }));
  await user.click(screen.getByRole("combobox", { name: "Account to merge in" }));
  await user.click(await screen.findByRole("option", { name: /^Sam \(Slack\)/ }));
}

describe("MergeMembersDialog", () => {
  it("previews the merge and requires explicit confirmation before merging", async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    await chooseAccounts(user);
    await user.click(screen.getByRole("button", { name: "Review merge" }));

    expect(props.previewMerge).toHaveBeenCalledWith({
      sourceUserId: slackSam.userId,
      targetUserId: githubSam.userId,
    });
    expect(await screen.findByText("GitHub · sam-gh")).toBeInTheDocument();
    expect(screen.getByText("Slack · sam@corp.example")).toBeInTheDocument();
    expect(screen.getByText("3 sessions")).toBeInTheDocument();
    expect(screen.getByText("1 linked sign-in")).toBeInTheDocument();

    const merge = screen.getByRole("button", { name: "Merge accounts" });
    expect(merge).toBeDisabled();
    await user.click(screen.getByRole("checkbox"));
    await user.click(merge);

    expect(props.mergeMembers).toHaveBeenCalledWith({
      sourceUserId: slackSam.userId,
      targetUserId: githubSam.userId,
    });
    await waitFor(() => expect(props.onOpenChange).toHaveBeenCalledWith(false));
  });

  it("does not let the signed-in user merge their own account away", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("combobox", { name: "Account to merge in" }));

    expect(await screen.findByRole("option", { name: /Ada.*you/ })).toHaveAttribute(
      "aria-disabled",
      "true"
    );
  });

  it("does not let Swap move the signed-in account into the merge-in slot", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("combobox", { name: "Account to keep" }));
    await user.click(await screen.findByRole("option", { name: /^Ada/ }));
    await user.click(screen.getByRole("combobox", { name: "Account to merge in" }));
    await user.click(await screen.findByRole("option", { name: /^Sam \(Slack\)/ }));

    expect(screen.getByRole("button", { name: "Swap accounts" })).toBeDisabled();
  });

  it("explains a role conflict without changing roles from the merge dialog", async () => {
    const user = userEvent.setup();
    renderDialog({
      previewMerge: vi.fn().mockResolvedValue(
        previewFor({
          target: { member: { ...githubSam, role: ADMIN_ROLE }, identities: [] },
          blocker: "role_conflict",
          counts: null,
        })
      ),
    });

    await chooseAccounts(user);
    await user.click(screen.getByRole("button", { name: "Review merge" }));

    expect(await screen.findByText(/different roles/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Merge accounts" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /^Make / })).not.toBeInTheDocument();
  });

  it("calls out a team lead promotion as an access change", async () => {
    const user = userEvent.setup();
    renderDialog({
      previewMerge: vi
        .fn()
        .mockResolvedValue(
          previewFor({ counts: counts({ teamLeadRolesPromoted: 1, teamMembershipsDeduped: 1 }) })
        ),
    });

    await chooseAccounts(user);
    await user.click(screen.getByRole("button", { name: "Review merge" }));

    expect(await screen.findByText("Access change:")).toBeInTheDocument();
    expect(
      screen.getByText(/becomes a lead of 1 team that Sam \(Slack\) leads/)
    ).toBeInTheDocument();
  });

  it("shows the server's reason when the merge fails", async () => {
    const user = userEvent.setup();
    const props = renderDialog({
      mergeMembers: vi.fn().mockRejectedValue(new Error("Actor authorization changed")),
    });

    await chooseAccounts(user);
    await user.click(screen.getByRole("button", { name: "Review merge" }));
    await user.click(await screen.findByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Merge accounts" }));

    expect(await screen.findByText("Actor authorization changed")).toBeInTheDocument();
    expect(props.onOpenChange).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuditLogSettings } from "./audit-log-settings";

expect.extend(matchers);

const hook = vi.hoisted(() => ({
  events: [] as Record<string, unknown>[],
  loading: false,
  validating: false,
  error: undefined as unknown,
  page: 1,
  hasPrevious: false,
  hasNext: false,
  previous: vi.fn(),
  next: vi.fn(),
  retry: vi.fn(),
}));

const filters = vi.hoisted(() => ({
  audit: vi.fn(),
  teams: vi.fn(),
  memberships: vi.fn(),
  allowed: true,
}));
vi.mock("@/hooks/use-audit-events", () => ({
  useAuditEvents: (...args: unknown[]) => {
    filters.audit(...args);
    return hook;
  },
}));
vi.mock("@/hooks/use-current-user-authorization", () => ({
  useCurrentUserAuthorization: () => ({ hasPermission: () => filters.allowed }),
}));
vi.mock("@/hooks/use-teams", () => ({
  useTeams: (enabled: boolean) => {
    filters.teams(enabled);
    return {
      teams: [
        { id: "team_one", name: "Design", archivedAt: null },
        { id: "team_two", name: "Engineering", archivedAt: null },
        { id: "team_archived", name: "Archived team", archivedAt: 1 },
      ],
      loading: false,
      error: null,
    };
  },
  useMeTeams: () => {
    filters.memberships();
    return {
      teams: [{ id: "team_one", name: "Design", archivedAt: null }],
      loading: false,
      error: null,
    };
  },
}));

const scrollIntoView = vi.fn();
Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
  configurable: true,
  value: scrollIntoView,
});

type OperationResult = "applied" | "no_op" | "denied" | "rejected";

function createEvent(operationResult: OperationResult, overrides: Record<string, unknown> = {}) {
  return {
    id: `event-${operationResult}`,
    occurredAt: 1_700_000_000_000,
    requestId: `request-${operationResult}`,
    principalKind: "user",
    actorUserIdSnapshot: "actor-snapshot-id",
    actorServiceSnapshot: null,
    action: "workspace.member_role_updated",
    resourceType: "user",
    resourceId: "resource-snapshot-id",
    targetUserIdSnapshot: "target-snapshot-id",
    reasonCode: "member_role_updated",
    operationResult,
    metadata: { before: { roleId: "role-old" }, after: { roleId: "role-new" } },
    ...overrides,
  };
}

function createAuthorizationEvent(
  action: string,
  operationResult: OperationResult,
  metadata: Record<string, unknown>
) {
  return createEvent(operationResult, {
    id: `event-${action}-${operationResult}-${String(metadata.httpStatus)}`,
    action,
    resourceType: "http_route",
    resourceId: "/workspace/members/user-2/role",
    targetUserIdSnapshot: null,
    reasonCode: action === "authorization.request_allowed" ? "authorization_allowed" : "forbidden",
    metadata,
  });
}

function decisionMetadata(httpStatus: unknown) {
  return {
    schema: "authorization_decision.v1",
    httpMethod: "PUT",
    httpPath: "/workspace/members/user-2/role",
    httpStatus,
    requirements: [{ kind: "permission", permission: "workspace.members.manage" }],
    requestId: "request-id",
    traceId: "trace-id",
  };
}

function renderSingle(event: Record<string, unknown>) {
  hook.events = [event];
  render(<AuditLogSettings />);
  return within(screen.getByRole("article"));
}

beforeEach(() => {
  filters.allowed = true;
  filters.audit.mockReset();
  filters.teams.mockReset();
  filters.memberships.mockReset();
  Object.assign(hook, {
    events: [],
    loading: false,
    validating: false,
    error: undefined,
    page: 1,
    hasPrevious: false,
    hasNext: false,
  });
  hook.previous.mockReset();
  hook.next.mockReset();
  hook.retry.mockReset();
  scrollIntoView.mockReset();
});

afterEach(cleanup);

describe("AuditLogSettings", () => {
  it("lets a workspace Owner filter audit events by a team they are not a member of", async () => {
    render(<AuditLogSettings />);
    expect(filters.teams).toHaveBeenLastCalledWith(true);
    expect(filters.memberships).not.toHaveBeenCalled();
    expect(screen.getByRole("option", { name: "Engineering" })).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Team" }), "team_two");
    expect(filters.audit).toHaveBeenLastCalledWith({ teamId: "team_two", enabled: true });
  });

  it("includes archived teams in the audit filter", async () => {
    render(<AuditLogSettings />);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Team" }), "team_archived");
    expect(filters.audit).toHaveBeenLastCalledWith({ teamId: "team_archived", enabled: true });
  });

  it("withholds the feed and filters without the existing audit permission", () => {
    filters.allowed = false;
    render(<AuditLogSettings />);
    expect(screen.queryByRole("combobox", { name: "Team" })).not.toBeInTheDocument();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    expect(filters.audit).toHaveBeenLastCalledWith({ teamId: undefined, enabled: false });
    expect(filters.teams).toHaveBeenLastCalledWith(false);
    expect(filters.memberships).not.toHaveBeenCalled();
  });

  it("gates all-team options and the feed as audit permission changes", () => {
    filters.allowed = false;
    const { rerender } = render(<AuditLogSettings />);
    expect(filters.teams).toHaveBeenLastCalledWith(false);
    expect(filters.audit).toHaveBeenLastCalledWith({ teamId: undefined, enabled: false });

    filters.allowed = true;
    rerender(<AuditLogSettings />);
    expect(filters.teams).toHaveBeenLastCalledWith(true);
    expect(filters.audit).toHaveBeenLastCalledWith({ teamId: undefined, enabled: true });
    expect(screen.getByRole("combobox", { name: "Team" })).toBeInTheDocument();

    filters.allowed = false;
    rerender(<AuditLogSettings />);
    expect(filters.teams).toHaveBeenLastCalledWith(false);
    expect(filters.audit).toHaveBeenLastCalledWith({ teamId: undefined, enabled: false });
    expect(screen.queryByRole("combobox", { name: "Team" })).not.toBeInTheDocument();
  });

  it("shows a team creation as an applied operation", () => {
    const article = renderSingle(createEvent("applied", { action: "team.created" }));
    expect(article.getByText("Team created")).toBeInTheDocument();
    expect(article.getByText("Applied")).toBeInTheDocument();
  });

  it.each([
    ["team.secret_set", "Team secret set"],
    ["team.secret_deleted", "Team secret deleted"],
    ["automation.executor_changed", "Automation executor changed"],
  ])("labels %s as an applied operation", (action, label) => {
    const article = renderSingle(createEvent("applied", { action }));
    expect(article.getByText(label)).toBeInTheDocument();
    expect(article.getByText("Applied")).toBeInTheDocument();
  });

  it("labels private session break-glass reads as operations", () => {
    const article = renderSingle(createEvent("applied", { action: "session.private_break_glass" }));
    expect(article.getByText("Private session break-glass read")).toBeInTheDocument();
    expect(article.getByText("Applied")).toBeInTheDocument();
  });

  it("renders outcomes, stable summaries, timestamps, and expandable structured details", async () => {
    hook.events = [
      createEvent("applied"),
      createEvent("no_op"),
      createEvent("denied"),
      createEvent("rejected", { actorServiceSnapshot: "github-bot" }),
      createEvent("applied", {
        id: "event-unknown",
        requestId: "request-unknown",
        action: "future_namespace.custom_action",
      }),
    ];
    const { container } = render(<AuditLogSettings />);

    expect(screen.getByRole("heading", { name: "Audit log" })).toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(5);
    for (const [label, className] of [
      ["Applied", "text-success"],
      ["No change", "text-muted-foreground"],
      ["Denied", "text-destructive"],
      ["Rejected", "text-warning"],
      ["Unrecognized", "text-muted-foreground"],
    ]) {
      expect(screen.getByText(label)).toHaveClass(className);
    }
    expect(screen.queryByText("HTTP response")).not.toBeInTheDocument();
    expect(screen.getAllByText(/actor-snapshot-id/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/resource-snapshot-id/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/target-snapshot-id/).length).toBeGreaterThan(0);
    expect(screen.getByText("future_namespace.custom_action")).toBeInTheDocument();
    expect(
      screen.getByText(/Service \/ github-bot \/ User actor \/ actor-snapshot-id/)
    ).toBeInTheDocument();

    const timestamp = screen.getAllByRole("time")[0];
    expect(timestamp).toHaveAttribute("title", new Date(1_700_000_000_000).toLocaleString());
    await userEvent.click(screen.getAllByText("Structured details")[0]);
    expect(screen.getAllByText(/"roleId": "role-old"/)[0]).toBeVisible();

    expect(container.querySelector("ul")).toHaveClass("min-w-0");
    expect(screen.getByText("request-applied")).toHaveClass("break-all");
  });

  it("renders empty and error states with a working retry action", async () => {
    const { rerender } = render(<AuditLogSettings />);
    expect(screen.getByText("No audit events yet")).toBeInTheDocument();

    hook.error = new Error("failed");
    rerender(<AuditLogSettings />);
    expect(screen.getByRole("alert")).toHaveTextContent("Unable to load the audit log.");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(hook.retry).toHaveBeenCalledOnce();
  });

  it("keeps cached events visible when a background refresh fails", async () => {
    hook.events = [createEvent("applied")];
    hook.error = new Error("failed");
    hook.hasNext = true;
    render(<AuditLogSettings />);

    expect(screen.getByRole("article")).toBeInTheDocument();
    expect(screen.queryByText("Unable to load the audit log.")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Unable to refresh the audit log. Showing the most recently loaded events."
    );
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(hook.retry).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("allows returning to a previous page after a later page fails", async () => {
    hook.error = new Error("failed");
    hook.page = 2;
    hook.hasPrevious = true;
    render(<AuditLogSettings />);

    expect(screen.getByRole("alert")).toHaveTextContent("Unable to load the audit log.");
    await userEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(hook.previous).toHaveBeenCalledOnce();
  });

  it("announces the loading state", () => {
    hook.loading = true;
    render(<AuditLogSettings />);

    expect(screen.getByText("Loading audit events...")).toBeInTheDocument();
  });

  it("keeps pagination mounted while loading a later page", () => {
    hook.loading = true;
    hook.page = 2;
    hook.hasPrevious = true;
    render(<AuditLogSettings />);

    expect(screen.getByRole("navigation", { name: "Audit log pagination" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
  });

  it("provides semantic Previous/Next pagination and page status", async () => {
    hook.events = [createEvent("applied")];
    hook.page = 3;
    hook.hasPrevious = true;
    hook.hasNext = true;
    render(<AuditLogSettings />);

    const pagination = screen.getByRole("navigation", { name: "Audit log pagination" });
    expect(pagination).toHaveTextContent("Page 3");
    await userEvent.click(screen.getByRole("button", { name: "Previous" }));
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(hook.previous).toHaveBeenCalledOnce();
    expect(hook.next).toHaveBeenCalledOnce();
  });

  it("moves focus and scroll context after a requested page loads", async () => {
    hook.events = [createEvent("applied")];
    hook.hasNext = true;
    const { rerender } = render(<AuditLogSettings />);

    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    hook.page = 2;
    hook.loading = true;
    hook.events = [];
    rerender(<AuditLogSettings />);
    expect(screen.getByRole("heading", { name: "Audit log" })).not.toHaveFocus();

    hook.loading = false;
    hook.events = [createEvent("applied", { id: "event-page-2" })];
    rerender(<AuditLogSettings />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Audit log" })).toHaveFocus());
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
  });

  it("explains what an authorization decision does and does not prove", () => {
    render(<AuditLogSettings />);

    expect(
      screen.getByText(/They do not confirm that the requested change took effect/)
    ).toBeInTheDocument();
  });

  it.each([
    ["authorization.request_allowed", "applied", 409, "Allowed", "text-info", "HTTP 409 Conflict"],
    [
      "authorization.request_denied",
      "denied",
      403,
      "Denied",
      "text-destructive",
      "HTTP 403 Forbidden",
    ],
  ] as const)(
    "renders %s as a decision with its HTTP response, not a domain outcome",
    (action, result, status, label, className, response) => {
      const card = renderSingle(createAuthorizationEvent(action, result, decisionMetadata(status)));

      expect(card.getByText(label)).toHaveClass(className);
      expect(card.queryByText("Applied")).not.toBeInTheDocument();
      expect(card.getByText(response)).toBeVisible();
    }
  );

  it("shows a legacy decision without fabricating a response", () => {
    const card = renderSingle(
      createAuthorizationEvent("authorization.request_allowed", "applied", { legacy: true })
    );

    expect(card.getByText("Allowed")).toBeInTheDocument();
    expect(card.getByText("Not recorded")).toBeInTheDocument();
  });

  it("keeps the raw operation result and metadata inspectable", async () => {
    const card = renderSingle(
      createAuthorizationEvent("authorization.request_allowed", "applied", decisionMetadata(409))
    );

    await userEvent.click(card.getByText("Structured details"));
    const details = card.getByText(/"operationResult": "applied"/);
    expect(details).toBeVisible();
    expect(details).toHaveTextContent('"httpStatus": 409');
  });
});

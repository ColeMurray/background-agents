// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { presentAuditEvent } from "@/lib/audit-event-presentation";
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

vi.mock("@/hooks/use-audit-events", () => ({ useAuditEvents: () => hook }));

const scrollIntoView = vi.fn();
Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
  configurable: true,
  value: scrollIntoView,
});

type OperationResult = "applied" | "no_op" | "denied" | "rejected";

const OPERATION_RESULTS: OperationResult[] = ["applied", "no_op", "denied", "rejected"];

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
  it("renders outcomes, stable summaries, timestamps, and expandable structured details", async () => {
    hook.events = [
      createEvent("applied"),
      createEvent("no_op"),
      createEvent("denied"),
      createEvent("rejected", {
        action: "future_namespace.custom_action",
        actorServiceSnapshot: "github-bot",
      }),
    ];
    const { container } = render(<AuditLogSettings />);

    expect(screen.getByRole("heading", { name: "Audit log" })).toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(4);
    for (const label of ["Applied", "No change", "Denied", "Rejected"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
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

  describe("authorization decisions", () => {
    const decisions = [
      { action: "authorization.request_allowed", label: "Allowed", className: "text-info" },
      { action: "authorization.request_denied", label: "Denied", className: "text-destructive" },
    ];
    const statuses = [
      { status: 200, text: "HTTP 200 OK" },
      { status: 201, text: "HTTP 201 Created" },
      { status: 400, text: "HTTP 400 Bad Request" },
      { status: 403, text: "HTTP 403 Forbidden" },
      { status: 409, text: "HTTP 409 Conflict" },
      { status: 500, text: "HTTP 500 Internal Server Error" },
    ];

    for (const decision of decisions) {
      for (const operationResult of OPERATION_RESULTS) {
        for (const { status, text } of statuses) {
          it(`renders ${decision.action} (${operationResult}, ${status}) as ${decision.label} with ${text}`, () => {
            const card = renderSingle(
              createAuthorizationEvent(decision.action, operationResult, decisionMetadata(status))
            );

            const badge = card.getByText(decision.label);
            expect(badge).toHaveClass(decision.className);
            expect(badge).not.toHaveClass("text-success");
            for (const label of ["Applied", "No change", "Rejected"]) {
              expect(card.queryByText(label)).not.toBeInTheDocument();
            }
            expect(card.getByText("HTTP response")).toBeVisible();
            expect(card.getByText(text)).toBeVisible();
          });
        }
      }
    }

    it("shows an unrecognized but valid HTTP status without inventing a reason phrase", () => {
      const card = renderSingle(
        createAuthorizationEvent("authorization.request_allowed", "applied", decisionMetadata(418))
      );

      expect(card.getByText("Allowed")).toBeInTheDocument();
      expect(card.getByText("HTTP 418")).toBeInTheDocument();
    });

    it.each([
      ["legacy metadata", { legacy: true }],
      ["a missing status", { schema: "authorization_decision.v1" }],
      ["an out-of-range status", decisionMetadata(99)],
      ["a non-integer status", decisionMetadata(200.5)],
      ["a string status", decisionMetadata("200")],
    ])("keeps the decision but reports the response as unavailable for %s", (_, metadata) => {
      const card = renderSingle(
        createAuthorizationEvent("authorization.request_allowed", "applied", metadata)
      );

      expect(card.getByText("Allowed")).toBeInTheDocument();
      expect(card.queryByText("Applied")).not.toBeInTheDocument();
      expect(card.getByText("Not recorded")).toBeInTheDocument();
      expect(card.queryByText(/^HTTP \d/)).not.toBeInTheDocument();
    });

    it("keeps raw operation result and metadata inspectable for forensic use", async () => {
      const card = renderSingle(
        createAuthorizationEvent("authorization.request_allowed", "applied", decisionMetadata(409))
      );

      await userEvent.click(card.getByText("Structured details"));
      const details = card.getByText(/"operationResult": "applied"/);
      expect(details).toBeVisible();
      expect(details).toHaveTextContent('"httpStatus": 409');
      expect(details).toHaveTextContent('"schema": "authorization_decision.v1"');
    });

    it.each([
      ["an unknown authorization action", "authorization.request_escalated", decisionMetadata(200)],
      [
        "a known action with an unknown schema",
        "authorization.request_allowed",
        { ...decisionMetadata(200), schema: "authorization_decision.v2" },
      ],
      ["an unknown action with a decision schema", "future.request_gate", decisionMetadata(201)],
    ])("renders %s neutrally without implying a completed mutation", (_, action, metadata) => {
      const card = renderSingle(createAuthorizationEvent(action, "applied", metadata));

      expect(card.getByText("Unclassified")).toHaveClass("text-muted-foreground");
      expect(card.queryByText("Applied")).not.toBeInTheDocument();
      expect(card.queryByText("Allowed")).not.toBeInTheDocument();
      expect(card.getByText(/^HTTP 20[01]/)).toBeInTheDocument();
    });
  });

  describe("operation outcomes", () => {
    it.each([
      ["applied", "Applied", "text-success"],
      ["no_op", "No change", "text-muted-foreground"],
      ["denied", "Denied", "text-destructive"],
      ["rejected", "Rejected", "text-warning"],
    ] as const)("renders a member role update with result %s as %s", (result, label, className) => {
      const card = renderSingle(createEvent(result));

      expect(card.getByText("Member role updated")).toBeInTheDocument();
      expect(card.getByText(label)).toHaveClass(className);
      expect(card.queryByText("HTTP response")).not.toBeInTheDocument();
    });

    it("keeps operation-owner outcomes even when metadata carries an httpStatus", () => {
      const card = renderSingle(
        createEvent("applied", {
          action: "workspace.member_status_updated",
          metadata: { before: {}, requested: {}, after: {}, httpStatus: 500 },
        })
      );

      expect(card.getByText("Member status updated")).toBeInTheDocument();
      expect(card.getByText("Applied")).toBeInTheDocument();
    });

    it("renders unknown action names verbatim, including prototype keys", () => {
      const card = renderSingle(createEvent("no_op", { action: "constructor" }));

      expect(card.getByRole("heading", { name: "constructor" })).toBeInTheDocument();
      expect(card.getByText("No change")).toBeInTheDocument();
    });
  });
});

describe("presentAuditEvent", () => {
  it("never derives an authorization decision from operationResult alone", () => {
    for (const operationResult of OPERATION_RESULTS) {
      expect(
        presentAuditEvent({
          action: "authorization.request_allowed",
          operationResult,
          metadata: decisionMetadata(409),
        })
      ).toEqual({ kind: "authorization", decision: "allowed", httpStatus: 409 });
      expect(
        presentAuditEvent({
          action: "authorization.request_denied",
          operationResult,
          metadata: decisionMetadata(403),
        })
      ).toEqual({ kind: "authorization", decision: "denied", httpStatus: 403 });
      expect(
        presentAuditEvent({
          action: "workspace.member_role_updated",
          operationResult,
          metadata: {},
        })
      ).toEqual({ kind: "operation", result: operationResult });
    }
  });
});

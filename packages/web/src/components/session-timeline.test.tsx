// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { SandboxEvent } from "@/types/session";
import { ToolCallGroup } from "./tool-call-group";
import { dedupeAndGroupEvents, EventItem } from "./session-timeline";

expect.extend(matchers);
afterEach(cleanup);

function event(userId?: string): SandboxEvent {
  return {
    type: "user_message",
    content: "hello",
    messageId: "message-1",
    timestamp: 1,
    author: {
      participantId: "participant-2",
      ...(userId ? { userId } : {}),
      name: "Historical Name",
      avatar: "https://historical.example/avatar",
    },
  };
}

function toolCall(callId: string, tool: string, filePath: string): SandboxEvent {
  return {
    type: "tool_call",
    sandboxId: "sandbox-1",
    messageId: `message-${callId}`,
    callId,
    tool,
    args: { filePath },
    timestamp: Number(callId.replace(/\D/g, "")) || 1,
  };
}

function ToolGroups({ events }: { events: SandboxEvent[] }) {
  return dedupeAndGroupEvents(events).map((group) =>
    group.type === "tool_group" ? (
      <ToolCallGroup key={group.id} events={group.events} groupId={group.id} />
    ) : null
  );
}

describe("user message authors", () => {
  it("uses the canonical profile name and avatar when available", () => {
    render(
      <EventItem
        event={event("user-2")}
        sessionId="session-1"
        currentParticipantId="participant-1"
        participantProfiles={{
          "user-2": {
            userId: "user-2",
            displayName: "Canonical Name",
            avatarUrl: "https://canonical.example/avatar",
          },
        }}
        onOpenMedia={() => {}}
      />
    );

    expect(screen.getByText("Canonical Name")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Canonical Name" })).toHaveAttribute(
      "src",
      "https://canonical.example/avatar"
    );
  });

  it("falls back safely for historical events without userId", () => {
    render(
      <EventItem
        event={event()}
        sessionId="session-1"
        currentParticipantId="participant-1"
        participantProfiles={{}}
        onOpenMedia={() => {}}
      />
    );

    expect(screen.getByText("Historical Name")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Historical Name" })).toHaveAttribute(
      "src",
      "https://historical.example/avatar"
    );
  });

  it("preserves event fallbacks when canonical profile fields are null", () => {
    render(
      <EventItem
        event={event("user-2")}
        sessionId="session-1"
        currentParticipantId="participant-1"
        participantProfiles={{
          "user-2": { userId: "user-2", displayName: null, avatarUrl: null },
        }}
        onOpenMedia={() => {}}
      />
    );

    expect(screen.getByText("Historical Name")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Historical Name" })).toHaveAttribute(
      "src",
      "https://historical.example/avatar"
    );
  });
});

describe("tool call groups", () => {
  it("preserves expanded group and row state when history is prepended", async () => {
    const readEvents = [
      toolCall("call-1", "Read", "/workspace/one.ts"),
      toolCall("call-2", "Read", "/workspace/two.ts"),
    ];
    const { rerender } = render(<ToolGroups events={readEvents} />);

    await userEvent.click(screen.getByRole("button", { name: /Read2 files/i }));
    await userEvent.click(screen.getByRole("button", { name: /Read one\.ts/i }));
    expect(screen.getByText("Arguments:")).toBeInTheDocument();

    rerender(<ToolGroups events={[toolCall("call-0", "Bash", "older command"), ...readEvents]} />);

    expect(screen.getByRole("button", { name: /Read one\.ts/i })).toBeInTheDocument();
    expect(screen.getByText("Arguments:")).toBeInTheDocument();
  });
});

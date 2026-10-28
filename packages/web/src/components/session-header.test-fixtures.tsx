import type { ComponentProps } from "react";
import type { SessionState } from "@open-inspect/shared/types/server-messages";
import { SessionHeader as SessionHeaderComponent } from "./session-header";
import type { SessionActionProps } from "./session-actions";
import type { SessionCapabilities } from "@/lib/session-capabilities";

export const FULL_CAPABILITIES: SessionCapabilities = {
  read: true,
  collaborate: true,
  lifecycle: true,
  delete: false,
  manageCollaborators: false,
  changeVisibility: false,
  sandboxAccess: true,
  exportTrace: true,
};

export function SessionHeader({
  capabilities = FULL_CAPABILITIES,
  reconnecting = false,
  ...props
}: Omit<ComponentProps<typeof SessionHeaderComponent>, "capabilities" | "reconnecting"> & {
  capabilities?: SessionCapabilities;
  reconnecting?: boolean;
}) {
  return (
    <SessionHeaderComponent {...props} capabilities={capabilities} reconnecting={reconnecting} />
  );
}

export const actions: SessionActionProps = {
  sessionId: "session-1",
  sessionStatus: "active",
  artifacts: [],
  capabilities: FULL_CAPABILITIES,
};

export function createSessionState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    id: "session-1",
    title: "Session 1",
    repoOwner: "acme",
    repoName: "web",
    baseBranch: "main",
    branchName: "feature/status-icons",
    status: "active",
    sandboxStatus: "ready",
    harness: "opencode",
    messageCount: 0,
    createdAt: 1,
    ...overrides,
  };
}

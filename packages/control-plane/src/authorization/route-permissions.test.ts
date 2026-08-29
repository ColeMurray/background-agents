import { describe, expect, it } from "vitest";
import { sessionUserOperation, staticUserPermission } from "./route-permissions";

describe("staticUserPermission", () => {
  it.each([
    ["PUT", "/secrets", "global_secrets.manage"],
    ["GET", "/repos/acme/app/secrets", "repositories.secrets.manage"],
    ["PUT", "/repos/acme/app/metadata", "repositories.settings.manage"],
    ["GET", "/repos", "repositories.read"],
    ["DELETE", "/environments/env-1", "environments.manage"],
    ["GET", "/environments/env-1", "environments.read"],
    ["PUT", "/commit-signing", "commit_signing.manage"],
    ["GET", "/integration-settings/slack/channels", "automations.read"],
    ["GET", "/integration-settings/slack/watched-channels", "automations.read"],
    ["PUT", "/integration-settings/slack/repos/acme/app", "repositories.settings.manage"],
    ["DELETE", "/integration-settings/slack/repos/acme/app", "repositories.settings.manage"],
    ["PUT", "/integration-settings/slack/config", "integrations.manage"],
    ["POST", "/skills/import", "skills.manage"],
    ["GET", "/mcp-servers", "mcp_servers.read"],
    ["POST", "/sessions", "sessions.create"],
    ["POST", "/sessions/parent/children", "sessions.create"],
  ] as const)("maps %s %s to %s", (method, path, permission) => {
    expect(staticUserPermission(method, path)).toBe(permission);
  });

  it.each([
    ["GET", "/model-preferences"],
    ["GET", "/keyboard-shortcuts"],
    ["DELETE", "/sessions/session-1"],
    ["POST", "/image-builds/build-complete"],
  ] as const)("leaves %s %s to active-user or contextual policy", (method, path) => {
    expect(staticUserPermission(method, path)).toBeNull();
  });
});

describe("sessionUserOperation", () => {
  it.each([
    ["GET", "/sessions/session-1/events", "read"],
    ["POST", "/sessions/session-1/prompt", "collaborate"],
    ["POST", "/sessions/session-1/archive", "lifecycle"],
    ["POST", "/sessions/session-1/participants", "participants.manage"],
    ["POST", "/sessions/session-1/children", "collaborate"],
    ["GET", "/sessions/session-1/sandbox-access", "sandbox_access"],
    ["DELETE", "/sessions/session-1", "delete"],
    ["POST", "/sessions/parent/children/child/cancel", "lifecycle"],
  ] as const)("classifies %s %s as %s", (method, path, operation) => {
    expect(sessionUserOperation(method, path)).toEqual({
      sessionId: path.includes("/children/child") ? "child" : "session-1",
      operation,
    });
  });
});

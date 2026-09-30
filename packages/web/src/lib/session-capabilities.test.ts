import { describe, expect, it } from "vitest";
import { resolveSessionCapabilities } from "./session-capabilities";
import type { SessionCapabilities } from "@open-inspect/shared";

const SERVER_CAPABILITIES: SessionCapabilities = {
  canRead: true,
  canCollaborate: false,
  canManageLifecycle: false,
  canDelete: false,
  canMove: true,
  canSandbox: false,
  canManageCollaborators: true,
  canChangeVisibility: true,
};

describe("resolveSessionCapabilities", () => {
  it("grants trace export only to users with sessions.export", () => {
    const readOnly = resolveSessionCapabilities((permission) => permission === "sessions.read");
    expect(readOnly.exportTrace).toBe(false);
    const exporter = resolveSessionCapabilities((permission) => permission === "sessions.export");
    expect(exporter.exportTrace).toBe(true);
  });

  it("uses server decisions rather than workspace permissions for session controls", () => {
    expect(resolveSessionCapabilities(() => true, SERVER_CAPABILITIES)).toEqual({
      read: true,
      collaborate: false,
      lifecycle: false,
      delete: false,
      move: true,
      sandboxAccess: false,
      manageCollaborators: true,
      changeVisibility: true,
      exportTrace: true,
    });
  });

  it("disables session controls when capabilities are absent even for an administrator", () => {
    expect(resolveSessionCapabilities(() => true)).toEqual({
      read: false,
      collaborate: false,
      lifecycle: false,
      delete: false,
      move: false,
      sandboxAccess: false,
      manageCollaborators: false,
      changeVisibility: false,
      exportTrace: true,
    });
  });
  it("does not grant trace export without the global permission", () => {
    expect(resolveSessionCapabilities(() => false, SERVER_CAPABILITIES).exportTrace).toBe(false);
  });
});

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
  it.each([
    { canRead: true, canExportTrace: true, allowed: true },
    { canRead: true, canExportTrace: false, allowed: false },
    { canRead: false, canExportTrace: true, allowed: false },
    { canRead: undefined, canExportTrace: true, allowed: false },
  ])(
    "grants trace export only with session read and workspace export: $canRead/$canExportTrace",
    ({ canRead, canExportTrace, allowed }) => {
      expect(resolveSessionCapabilities({ canRead }, canExportTrace).exportTrace).toBe(allowed);
    }
  );
  it("uses the server's session capabilities, not workspace permission grants", () => {
    expect(
      resolveSessionCapabilities({
        canRead: true,
        canCollaborate: false,
        canManageLifecycle: false,
        canSandbox: false,
      })
    ).toEqual({
      read: true,
      collaborate: false,
      lifecycle: false,
      delete: false,
      move: false,
      manageCollaborators: false,
      changeVisibility: false,
      sandboxAccess: false,
      exportTrace: false,
    });
    expect(
      resolveSessionCapabilities({
        canRead: true,
        canCollaborate: true,
        canManageLifecycle: true,
        canSandbox: true,
      })
    ).toMatchObject({
      collaborate: true,
      lifecycle: true,
      sandboxAccess: true,
    });
  });
  it("fails closed when response capabilities are missing", () => {
    expect(resolveSessionCapabilities(undefined, true)).toEqual({
      read: false,
      collaborate: false,
      lifecycle: false,
      delete: false,
      move: false,
      manageCollaborators: false,
      changeVisibility: false,
      sandboxAccess: false,
      exportTrace: false,
    });
  });

  it("uses server decisions rather than workspace permissions for session controls", () => {
    expect(resolveSessionCapabilities(SERVER_CAPABILITIES, true)).toEqual({
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
    expect(resolveSessionCapabilities(undefined, true)).toEqual({
      read: false,
      collaborate: false,
      lifecycle: false,
      delete: false,
      move: false,
      sandboxAccess: false,
      manageCollaborators: false,
      changeVisibility: false,
      exportTrace: false,
    });
  });
  it("does not grant trace export without the global permission", () => {
    expect(resolveSessionCapabilities(SERVER_CAPABILITIES, false).exportTrace).toBe(false);
  });

  it("denies all actions without session read even when every action is granted", () => {
    expect(
      resolveSessionCapabilities(
        {
          canRead: false,
          canCollaborate: true,
          canManageLifecycle: true,
          canDelete: true,
          canMove: true,
          canManageCollaborators: true,
          canChangeVisibility: true,
          canSandbox: true,
        },
        true
      )
    ).toEqual(resolveSessionCapabilities(undefined));
  });
});

import { describe, expect, it } from "vitest";
import { resolveSessionCapabilities } from "./session-capabilities";

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
      sandboxAccess: false,
      exportTrace: false,
    });
  });
});

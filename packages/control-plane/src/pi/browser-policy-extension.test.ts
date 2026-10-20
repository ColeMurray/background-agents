import { describe, expect, it, vi } from "vitest";
import { createBrowserPolicyDelegate } from "./browser-policy-extension";

const declaration = { effect: "external_mutation", replay: "unsafe" } as never;
const context = { abortSignal: undefined } as never;
const api = {} as never;

describe("browser policy delegate", () => {
  it("allows the browser when the session authorizes it", async () => {
    const authorize = vi.fn(async () => ({ allowed: true }));
    const delegate = createBrowserPolicyDelegate({ client: { authorize } });

    await expect(
      delegate.beforeTool?.(
        { id: "call-1", name: "browser", arguments: { code: "" } } as never,
        declaration,
        api,
        context
      )
    ).resolves.toBeUndefined();
    expect(authorize).toHaveBeenCalled();
  });

  it("blocks the browser when the session refuses it", async () => {
    const delegate = createBrowserPolicyDelegate({
      client: {
        authorize: async () => ({
          allowed: false,
          code: "browser_disabled",
          reason: "Browser work is disabled for this session",
        }),
      },
    });

    await expect(
      delegate.beforeTool?.(
        { id: "call-1", name: "browser", arguments: { code: "" } } as never,
        declaration,
        api,
        context
      )
    ).resolves.toEqual({ block: "Browser work is disabled for this session" });
  });

  it("blocks the browser when the session cannot be asked", async () => {
    const delegate = createBrowserPolicyDelegate({
      client: {
        authorize: async () => {
          throw new Error("The session is unavailable");
        },
      },
    });

    await expect(
      delegate.beforeTool?.(
        { id: "call-1", name: "browser", arguments: { code: "" } } as never,
        declaration,
        api,
        context
      )
    ).resolves.toEqual({ block: "The session is unavailable" });
  });

  it("leaves other tools alone", async () => {
    const authorize = vi.fn(async () => ({ allowed: false }));
    const delegate = createBrowserPolicyDelegate({ client: { authorize } });

    await expect(
      delegate.beforeTool?.(
        { id: "call-1", name: "repository_read", arguments: {} } as never,
        declaration,
        api,
        context
      )
    ).resolves.toBeUndefined();
    expect(authorize).not.toHaveBeenCalled();
  });
});

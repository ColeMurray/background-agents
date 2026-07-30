import { describe, expect, it, vi } from "vitest";
import {
  parseExpectedProviders,
  verifyLoginProviders,
} from "../../../../scripts/verify-login-providers.mjs";

describe("login provider post-deploy verification", () => {
  it.each(["", "github,github", "saml", "google,github"])(
    "rejects invalid expected provider input %j",
    (providers) => {
      expect(() => parseExpectedProviders(providers)).toThrow("Expected providers");
    }
  );

  it.each([
    ["github", '<button data-sign-in-provider="github">Sign in with GitHub</button>', ["github"]],
    ["google", '<button data-sign-in-provider="google">Sign in with Google</button>', ["google"]],
    [
      "github,google",
      '<button data-sign-in-provider="github">Sign in with GitHub</button>' +
        '<button data-sign-in-provider="google">Sign in with Google</button>',
      ["github", "google"],
    ],
  ] as const)(
    "requests /login and accepts the exact %s provider markers",
    async (value, html, expected) => {
      const fetchImpl = vi.fn().mockResolvedValue(new Response(html));

      await expect(
        verifyLoginProviders("https://inspect.example", value, fetchImpl)
      ).resolves.toEqual(expected);
      expect(fetchImpl).toHaveBeenCalledWith("https://inspect.example/login", {
        headers: { accept: "text/html" },
        redirect: "manual",
        signal: expect.any(AbortSignal),
      });
    }
  );

  it("fails when an expected provider marker is missing", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response('<button data-sign-in-provider="github">Sign in with GitHub</button>')
      );

    await expect(
      verifyLoginProviders("https://inspect.example", "github,google", fetchImpl)
    ).rejects.toThrow("Rendered login providers do not match");
  });

  it("fails when an unconfigured provider marker is rendered", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(`
        <button data-sign-in-provider="github">Sign in with GitHub</button>
        <button data-sign-in-provider="google">Sign in with Google</button>
      `)
    );

    await expect(
      verifyLoginProviders("https://inspect.example", "github", fetchImpl)
    ).rejects.toThrow("Rendered login providers do not match");
  });

  it("fails when an unknown provider marker is rendered", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(`
        <button data-sign-in-provider="github">Sign in with GitHub</button>
        <button data-sign-in-provider="saml">Sign in</button>
      `)
    );

    await expect(
      verifyLoginProviders("https://inspect.example", "github", fetchImpl)
    ).rejects.toThrow("Rendered login providers do not match");
  });

  it("ignores provider presentation text outside a provider marker", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(`
        <p>Sign in with GitHub</p>
        <button data-sign-in-provider="google">Sign in with Google</button>
      `)
    );

    await expect(
      verifyLoginProviders("https://inspect.example", "google", fetchImpl)
    ).resolves.toEqual(["google"]);
  });

  it("fails without including an upstream response body", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("sensitive upstream body", { status: 503 }));

    await expect(
      verifyLoginProviders("https://inspect.example", "github", fetchImpl)
    ).rejects.toThrow("Login page returned HTTP 503");
  });

  it("fails with a sanitized error when the login request times out", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(new DOMException("sensitive network detail", "TimeoutError"));

    await expect(
      verifyLoginProviders("https://inspect.example", "github", fetchImpl)
    ).rejects.toThrow("Timed out waiting for the login page");
  });
});

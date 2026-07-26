import { describe, expect, it } from "vitest";
import { oauthProtocolRoutes } from "./oauth-registration";

describe("OAuth protocol route registration", () => {
  it("assembles only the four executable first-party OAuth endpoints", () => {
    expect(
      oauthProtocolRoutes.map((route) => [
        route.method,
        ["/oauth/authorize", "/oauth/callback/github", "/oauth/token", "/oauth/revoke"].find(
          (path) => route.pattern.test(path)
        ),
      ])
    ).toEqual([
      ["GET", "/oauth/authorize"],
      ["GET", "/oauth/callback/github"],
      ["POST", "/oauth/token"],
      ["POST", "/oauth/revoke"],
    ]);
  });
});

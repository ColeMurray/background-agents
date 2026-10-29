import { expect, it } from "vitest";
import { BROWSER_AUTH_CALLBACK_TIMEOUT_MS } from "@/lib/browser-auth-proxy";
import { maxDuration } from "./route";

it("leaves platform execution headroom beyond the OAuth callback transport deadline", () => {
  expect(maxDuration * 1000).toBeGreaterThan(BROWSER_AUTH_CALLBACK_TIMEOUT_MS);
});

import { expect, it } from "vitest";
import { SessionInternalPaths } from "../contracts";
import { createSessionInternalRoutes, type SessionInternalRouteHandlers } from "./routes";

it("retains the sandbox execution internal route", () => {
  const routes = createSessionInternalRoutes({} as SessionInternalRouteHandlers);
  const methods = new Map(routes.map(({ path, method }) => [path, method]));

  expect(methods.get(SessionInternalPaths.piSandboxCommand)).toBe("POST");
  expect(methods.size).toBe(routes.length);
});

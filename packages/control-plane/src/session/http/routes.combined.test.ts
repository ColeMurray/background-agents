import { expect, it } from "vitest";
import { SessionInternalPaths } from "../contracts";
import { createSessionInternalRoutes, type SessionInternalRouteHandlers } from "./routes";

it("retains sandbox execution and every external-action internal route", () => {
  const routes = createSessionInternalRoutes({} as SessionInternalRouteHandlers);
  const methods = new Map(routes.map(({ path, method }) => [path, method]));

  expect(methods.get(SessionInternalPaths.piSandboxCommand)).toBe("POST");
  expect(methods.get(SessionInternalPaths.piExternalActionPrepare)).toBe("POST");
  expect(methods.get(SessionInternalPaths.piExternalActionStatus)).toBe("GET");
  expect(methods.get(SessionInternalPaths.piExternalActionExecute)).toBe("POST");
  expect(methods.get(SessionInternalPaths.externalActionStatus)).toBe("GET");
  expect(methods.get(SessionInternalPaths.externalActionDecision)).toBe("POST");
  expect(methods.size).toBe(routes.length);
});

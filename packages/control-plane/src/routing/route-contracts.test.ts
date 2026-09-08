import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createTestBackgroundTasks } from "../background-tasks.test-support";
import { json, NO_AUTHORIZATION, requirePermission } from "../routes/shared";
import { admit } from "./admit";
import { createControlPlaneApp, type ControlPlaneHonoEnv, type ControlPlaneHost } from "./hono-app";
import { listRouteContracts } from "./route-contracts";

const PUBLIC = { authentication: { kind: "public" }, supportedScmProviders: "all" } as const;
const host: ControlPlaneHost = { backgroundTasks: () => createTestBackgroundTasks() };

describe("listRouteContracts", () => {
  it("lists module routes in registration order with their policies", () => {
    const module = new Hono<ControlPlaneHonoEnv>();
    module.get("/module/:id", admit({ ...PUBLIC, authorization: NO_AUTHORIZATION }), () =>
      json({})
    );
    module.post(
      "/module/:id",
      admit({
        authentication: { kind: "user" },
        supportedScmProviders: ["github"],
        authorization: requirePermission("sessions.create"),
        cacheControl: "no-store",
      }),
      () => json({})
    );
    const app = createControlPlaneApp([module], host);
    const contracts = listRouteContracts(app);

    expect(contracts.map((contract) => `${contract.method} ${contract.path}`)).toEqual([
      "GET /module/:id",
      "POST /module/:id",
    ]);
    expect(contracts[1]).toMatchObject({
      authentication: { kind: "user" },
      supportedScmProviders: ["github"],
      authorization: { kind: "active-user" },
      cacheControl: "no-store",
    });
    expect(contracts[0].cacheControl).toBeUndefined();
  });

  it("refuses to enumerate an app whose route does not begin with admit()", () => {
    // Built by hand, since createControlPlaneApp refuses such a module outright.
    const app = new Hono();
    app.use("*", async (_c, next) => next());
    app.options("*", (c) => c.body(null));
    app.get("/admitted", admit({ ...PUBLIC, authorization: NO_AUTHORIZATION }), () => json({}));
    expect(listRouteContracts(app).map((contract) => contract.path)).toEqual(["/admitted"]);

    app.get("/naked", () => json({}));
    expect(() => listRouteContracts(app)).toThrow("Route does not begin with admit(): GET /naked");
  });
});

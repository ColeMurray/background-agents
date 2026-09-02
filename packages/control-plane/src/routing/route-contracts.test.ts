import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createTestBackgroundTasks } from "../background-tasks.test-support";
import { defineRoute, json, NO_AUTHORIZATION, requirePermission } from "../routes/shared";
import { admit } from "./admit";
import { createControlPlaneApp, type ControlPlaneHonoEnv, type ControlPlaneHost } from "./hono-app";
import { listRouteContracts } from "./route-contracts";

const PUBLIC = { authentication: { kind: "public" }, supportedScmProviders: "all" } as const;
const host: ControlPlaneHost = { backgroundTasks: () => createTestBackgroundTasks() };

describe("listRouteContracts", () => {
  it("lists modules and legacy routes in registration order with their policies", () => {
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
    const legacy = defineRoute(PUBLIC, {
      method: "GET",
      path: "/legacy",
      authorization: NO_AUTHORIZATION,
      handler: async () => json({}),
    });

    const app = createControlPlaneApp([legacy, module], host);
    const contracts = listRouteContracts(app);

    expect(contracts.map((contract) => `${contract.method} ${contract.path}`)).toEqual([
      "GET /legacy",
      "GET /module/:id",
      "POST /module/:id",
    ]);
    expect(contracts[2]).toMatchObject({
      authentication: { kind: "user" },
      supportedScmProviders: ["github"],
      authorization: { kind: "active-user" },
      cacheControl: "no-store",
    });
    expect(contracts[0].cacheControl).toBeUndefined();
  });
});

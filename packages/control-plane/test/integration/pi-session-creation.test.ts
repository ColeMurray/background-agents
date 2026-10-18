import { createExecutionContext, env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { PiFeatureCapabilitySnapshot } from "@open-inspect/shared/pi-feature-capabilities";
import type { WorkerBindings } from "../../src/cloudflare/platform";
import { PI_FEATURE_CAPABILITY_SNAPSHOT_KEY } from "../../src/pi/capability-snapshot";
import type { PiRuntimeDispatch } from "../../src/pi/runtime-contract";
import { SessionIndexStore } from "../../src/db/session-index";
import { ModelProviderAccountStore } from "../../src/db/model-provider-accounts";
import { cleanD1Tables } from "./cleanup";
import { queryDO, routeRequest, serviceRequestHeaders } from "./helpers";
import { runInSessionDO, type SessionDOInternals } from "./session-do-access";

describe("public Pi session creation recovery", () => {
  beforeEach(cleanD1Tables);

  it("retries exact initialization when Pi commits before the first RPC response is lost", async () => {
    const piNamespace = env.PI_SESSION;
    if (!piNamespace) throw new Error("PI_SESSION test binding is missing");
    let initializeAttempts = 0;
    const instrumentedSessionNamespace = {
      idFromName: env.SESSION.idFromName.bind(env.SESSION),
      get(id: DurableObjectId) {
        const stub = env.SESSION.get(id);
        return {
          async fetch(request: Request) {
            if (new URL(request.url).pathname === "/internal/init") {
              await runInSessionDO(stub, (instance) => {
                const appEnv = (instance as unknown as SessionDOInternals).appEnv;
                const actualPi = appEnv.PI_SESSION;
                if (!actualPi) throw new Error("SessionDO PI_SESSION dispatch is missing");
                appEnv.PI_SESSION = {
                  ...actualPi,
                  async initialize(sessionId: string, snapshot: PiFeatureCapabilitySnapshot) {
                    initializeAttempts++;
                    await actualPi.initialize(sessionId, snapshot);
                    if (initializeAttempts === 1) {
                      throw new Error("initialize response lost after commit");
                    }
                  },
                } satisfies PiRuntimeDispatch;
              });
            }
            return stub.fetch(request);
          },
        };
      },
    } as unknown as WorkerBindings["SESSION"];
    const url = "https://test.local/sessions";
    const providerAccountId = "88888888888888888888888888888888";
    const body = JSON.stringify({
      title: "Pi response-loss recovery",
      harness: "pi",
      model: "openai/gpt-5.6-sol",
      providerSelections: {
        openai: { mode: "provider_account", accountId: providerAccountId },
      },
    });
    const browserUserId = "99999999999999999999999999999999";
    const headers = await serviceRequestHeaders(url, {
      method: "POST",
      body,
      as: { userId: browserUserId, role: "owner" },
    });
    await new ModelProviderAccountStore(env.DB).create({
      id: providerAccountId,
      provider: "openai",
      displayName: "Pi Creation Account",
      actorId: browserUserId,
    });
    const response = await routeRequest(
      new Request(url, {
        method: "POST",
        headers,
        body,
      }),
      {
        ...env,
        PI_DURABLE_ENABLED: "true",
        SESSION: instrumentedSessionNamespace,
      },
      createExecutionContext()
    );

    expect(response.status, await response.clone().text()).toBe(201);
    expect(initializeAttempts).toBe(2);
    const { sessionId } = await response.json<{ sessionId: string }>();
    const indexed = await new SessionIndexStore(env.DB).get(sessionId);
    expect(indexed).toMatchObject({ id: sessionId, harness: "pi", status: "created" });

    const sessionStub = env.SESSION.getByName(sessionId);
    const sessionRows = await queryDO<{ pi_feature_capability_snapshot: string }>(
      sessionStub,
      "SELECT pi_feature_capability_snapshot FROM session"
    );
    const sessionSnapshot = JSON.parse(sessionRows[0]!.pi_feature_capability_snapshot);
    const piStub = piNamespace.getByName(sessionId);
    const piSnapshot = await runInDurableObject(piStub, (_instance, state) =>
      state.storage.get(PI_FEATURE_CAPABILITY_SNAPSHOT_KEY)
    );
    expect(piSnapshot).toEqual(sessionSnapshot);
  });
});

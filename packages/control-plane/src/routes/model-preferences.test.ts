import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ENABLED_MODELS, DEFAULT_MODEL, DEFAULT_PLAN_MODEL } from "@open-inspect/shared";
import { modelPreferencesRoutes } from "./model-preferences";
import { ModelPreferencesValidationError } from "../db/model-preferences";
import type { RequestContext } from "./shared";
import type { Env } from "../types";

const mockStore = {
  getPreferences: vi.fn(),
  setPreferences: vi.fn(),
  getEnabledModels: vi.fn(),
};

vi.mock("../db/model-preferences", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    ModelPreferencesStore: vi.fn().mockImplementation(() => mockStore),
  };
});

function getHandler(method: string, path: string) {
  const pathname = new URL(`https://test.local${path}`).pathname;
  for (const route of modelPreferencesRoutes) {
    if (route.method === method && route.pattern.test(pathname)) {
      const match = pathname.match(route.pattern)!;
      return { handler: route.handler, match };
    }
  }
  throw new Error(`No route found for ${method} ${path}`);
}

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as D1Database,
    ...overrides,
  } as Env;
}

function createCtx(): RequestContext {
  return {
    trace_id: "trace-1",
    request_id: "req-1",
    metrics: {
      d1Queries: [],
      spans: {},
      time: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      summarize: () => ({}),
    },
  };
}

async function callGet(env: Env): Promise<Response> {
  const { handler, match } = getHandler("GET", "/model-preferences");
  return handler(
    new Request("https://test.local/model-preferences", { method: "GET" }),
    env,
    match,
    createCtx()
  );
}

async function callPut(env: Env, body: unknown): Promise<Response> {
  const { handler, match } = getHandler("PUT", "/model-preferences");
  return handler(
    new Request("https://test.local/model-preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
    match,
    createCtx()
  );
}

describe("GET /model-preferences", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns shared defaults when no env vars and no DB row", async () => {
    mockStore.getPreferences.mockResolvedValue(null);
    const res = await callGet(createEnv());
    const body = (await res.json()) as {
      defaultModel: string;
      defaultPlanModel: string;
      enabledModels: string[];
    };

    expect(res.status).toBe(200);
    expect(body.defaultModel).toBe(DEFAULT_MODEL);
    expect(body.defaultPlanModel).toBe(DEFAULT_PLAN_MODEL);
    expect(body.enabledModels).toEqual(DEFAULT_ENABLED_MODELS);
  });

  it("uses env vars (normalized) when DB row has null defaults and env values are enabled", async () => {
    mockStore.getPreferences.mockResolvedValue({
      enabledModels: ["anthropic/claude-haiku-4-5", "anthropic/claude-opus-4-6"],
      defaultModel: null,
      defaultPlanModel: null,
    });
    const res = await callGet(
      createEnv({
        DEFAULT_MODEL: "claude-haiku-4-5",
        DEFAULT_PLAN_MODEL: "claude-opus-4-6",
      })
    );
    const body = (await res.json()) as { defaultModel: string; defaultPlanModel: string };

    expect(body.defaultModel).toBe("anthropic/claude-haiku-4-5");
    expect(body.defaultPlanModel).toBe("anthropic/claude-opus-4-6");
  });

  it("reconciles env-var defaults that aren't in enabledModels by substituting the first enabled model", async () => {
    // Regression test for CodeRabbit #672 follow-up: returning defaults
    // that aren't members of enabledModels broke the invariant enforced
    // by setPreferences — the Settings page couldn't re-save the
    // returned tuple without first picking a different default.
    mockStore.getPreferences.mockResolvedValue({
      enabledModels: ["anthropic/claude-sonnet-4-6"],
      defaultModel: null,
      defaultPlanModel: null,
    });
    const res = await callGet(
      createEnv({
        DEFAULT_MODEL: "claude-haiku-4-5", // NOT in enabledModels
        DEFAULT_PLAN_MODEL: "claude-opus-4-6", // also NOT in enabledModels
      })
    );
    const body = (await res.json()) as { defaultModel: string; defaultPlanModel: string };

    expect(body.defaultModel).toBe("anthropic/claude-sonnet-4-6");
    expect(body.defaultPlanModel).toBe("anthropic/claude-sonnet-4-6");
  });

  it("prefers DB defaults over env vars (DB > env > shared)", async () => {
    mockStore.getPreferences.mockResolvedValue({
      enabledModels: ["anthropic/claude-opus-4-7"],
      defaultModel: "anthropic/claude-opus-4-7",
      defaultPlanModel: "anthropic/claude-opus-4-7",
    });
    const res = await callGet(
      createEnv({
        DEFAULT_MODEL: "claude-haiku-4-5",
        DEFAULT_PLAN_MODEL: "claude-haiku-4-5",
      })
    );
    const body = (await res.json()) as { defaultModel: string; defaultPlanModel: string };

    expect(body.defaultModel).toBe("anthropic/claude-opus-4-7");
    expect(body.defaultPlanModel).toBe("anthropic/claude-opus-4-7");
  });

  it("falls back to shared defaults when env vars hold invalid model ids", async () => {
    mockStore.getPreferences.mockResolvedValue(null);
    const res = await callGet(
      createEnv({
        DEFAULT_MODEL: "garbage-model",
        DEFAULT_PLAN_MODEL: "also-garbage",
      })
    );
    const body = (await res.json()) as { defaultModel: string; defaultPlanModel: string };

    // getValidModelOrDefault falls back to DEFAULT_MODEL for invalid input
    expect(body.defaultModel).toBe(DEFAULT_MODEL);
    expect(body.defaultPlanModel).toBe(DEFAULT_MODEL);
  });

  it("still includes defaults when the D1 binding is missing", async () => {
    const res = await callGet(
      createEnv({
        DB: undefined as unknown as D1Database,
        DEFAULT_MODEL: "claude-haiku-4-5",
      })
    );
    const body = (await res.json()) as {
      defaultModel: string;
      defaultPlanModel: string;
      enabledModels: string[];
    };

    expect(res.status).toBe(200);
    expect(body.defaultModel).toBe("anthropic/claude-haiku-4-5");
    expect(body.defaultPlanModel).toBe(DEFAULT_PLAN_MODEL);
    expect(body.enabledModels).toEqual(DEFAULT_ENABLED_MODELS);
  });

  it("still includes defaults when the store throws", async () => {
    mockStore.getPreferences.mockRejectedValue(new Error("boom"));
    const res = await callGet(
      createEnv({
        DEFAULT_MODEL: "claude-sonnet-4-5",
      })
    );
    const body = (await res.json()) as {
      defaultModel: string;
      defaultPlanModel: string;
      enabledModels: string[];
    };

    expect(res.status).toBe(200);
    expect(body.defaultModel).toBe("anthropic/claude-sonnet-4-5");
    expect(body.enabledModels).toEqual(DEFAULT_ENABLED_MODELS);
  });

  it("preserves user-configured enabledModels alongside defaults", async () => {
    mockStore.getPreferences.mockResolvedValue({
      enabledModels: ["anthropic/claude-haiku-4-5"],
      defaultModel: null,
      defaultPlanModel: null,
    });
    const res = await callGet(createEnv({ DEFAULT_MODEL: "claude-haiku-4-5" }));
    const body = (await res.json()) as {
      defaultModel: string;
      enabledModels: string[];
    };

    expect(body.enabledModels).toEqual(["anthropic/claude-haiku-4-5"]);
    expect(body.defaultModel).toBe("anthropic/claude-haiku-4-5");
  });
});

describe("PUT /model-preferences", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists all three fields atomically and echoes them back", async () => {
    mockStore.setPreferences.mockResolvedValue(undefined);

    const res = await callPut(createEnv(), {
      enabledModels: ["anthropic/claude-haiku-4-5", "anthropic/claude-opus-4-6"],
      defaultModel: "anthropic/claude-haiku-4-5",
      defaultPlanModel: "anthropic/claude-opus-4-6",
    });
    const body = (await res.json()) as {
      status: string;
      enabledModels: string[];
      defaultModel: string;
      defaultPlanModel: string;
    };

    expect(res.status).toBe(200);
    expect(body.status).toBe("updated");
    expect(body.enabledModels).toEqual(["anthropic/claude-haiku-4-5", "anthropic/claude-opus-4-6"]);
    expect(body.defaultModel).toBe("anthropic/claude-haiku-4-5");
    expect(body.defaultPlanModel).toBe("anthropic/claude-opus-4-6");

    expect(mockStore.setPreferences).toHaveBeenCalledWith({
      enabledModels: ["anthropic/claude-haiku-4-5", "anthropic/claude-opus-4-6"],
      defaultModel: "anthropic/claude-haiku-4-5",
      defaultPlanModel: "anthropic/claude-opus-4-6",
    });
  });

  it("accepts null defaults (= delegate to env/shared fallback)", async () => {
    mockStore.setPreferences.mockResolvedValue(undefined);

    const res = await callPut(createEnv(), {
      enabledModels: ["anthropic/claude-haiku-4-5"],
      defaultModel: null,
      defaultPlanModel: null,
    });

    expect(res.status).toBe(200);
    expect(mockStore.setPreferences).toHaveBeenCalledWith({
      enabledModels: ["anthropic/claude-haiku-4-5"],
      defaultModel: null,
      defaultPlanModel: null,
    });
  });

  it("treats missing defaults fields as null", async () => {
    mockStore.setPreferences.mockResolvedValue(undefined);

    await callPut(createEnv(), {
      enabledModels: ["anthropic/claude-haiku-4-5"],
    });

    expect(mockStore.setPreferences).toHaveBeenCalledWith({
      enabledModels: ["anthropic/claude-haiku-4-5"],
      defaultModel: null,
      defaultPlanModel: null,
    });
  });

  it("returns 400 when the body is missing enabledModels", async () => {
    const res = await callPut(createEnv(), { defaultModel: "anthropic/claude-haiku-4-5" });
    expect(res.status).toBe(400);
    expect(mockStore.setPreferences).not.toHaveBeenCalled();
  });

  it("returns 400 with a clear message when a default is not in enabledModels", async () => {
    mockStore.setPreferences.mockRejectedValue(
      new ModelPreferencesValidationError(
        'Default model "anthropic/claude-opus-4-7" is not in the enabled models list'
      )
    );

    const res = await callPut(createEnv(), {
      enabledModels: ["anthropic/claude-haiku-4-5"],
      defaultModel: "anthropic/claude-opus-4-7",
      defaultPlanModel: null,
    });
    const body = (await res.json()) as { error: string };

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/not in the enabled models list/);
  });

  it("returns 503 when the DB binding is missing", async () => {
    const res = await callPut(createEnv({ DB: undefined as unknown as D1Database }), {
      enabledModels: ["anthropic/claude-haiku-4-5"],
    });
    expect(res.status).toBe(503);
  });

  it("returns 503 on unexpected store errors", async () => {
    mockStore.setPreferences.mockRejectedValue(new Error("disk full"));
    const res = await callPut(createEnv(), {
      enabledModels: ["anthropic/claude-haiku-4-5"],
    });
    expect(res.status).toBe(503);
  });
});

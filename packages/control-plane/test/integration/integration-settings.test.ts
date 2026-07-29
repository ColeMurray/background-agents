import { describe, it, expect, beforeEach } from "vitest";
import { SELF, env } from "cloudflare:test";
import {
  DEFAULT_MAX_CONCURRENT_CHILD_SESSIONS,
  DEFAULT_MAX_TOTAL_CHILD_SESSIONS,
} from "@open-inspect/shared";
import { EnvironmentStore } from "../../src/db/environments";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch } from "./helpers";

describe("Integration settings API", () => {
  beforeEach(cleanD1Tables);

  describe("auth", () => {
    it("returns 401 without auth header", async () => {
      const response = await SELF.fetch("https://test.local/integration-settings/github", {
        headers: { "Content-Type": "application/json" },
      });
      expect(response.status).toBe(401);
    });

    it("returns 401 on environment-level settings routes without auth header", async () => {
      for (const method of ["GET", "PUT", "DELETE"] as const) {
        const response = await SELF.fetch(
          "https://test.local/integration-settings/sandbox/environments/env_1",
          {
            method,
            headers: { "Content-Type": "application/json" },
            ...(method === "PUT" ? { body: JSON.stringify({ settings: {} }) } : {}),
          }
        );
        expect(response.status).toBe(401);
      }
    });
  });

  describe("unknown integration ID", () => {
    it("returns 404 for unknown integration", async () => {
      const response = await serviceFetch("https://test.local/integration-settings/unknownthing");
      expect(response.status).toBe(404);
      const body = await response.json<{ error: string }>();
      expect(body.error).toContain("Unknown integration");
    });
  });

  describe("GET /integration-settings/github", () => {
    it("returns null settings when unconfigured", async () => {
      const response = await serviceFetch("https://test.local/integration-settings/github");
      expect(response.status).toBe(200);
      const body = await response.json<{ integrationId: string; settings: unknown }>();
      expect(body.integrationId).toBe("github");
      expect(body.settings).toBeNull();
    });
  });

  describe("GET /integration-settings/linear", () => {
    it("returns null settings when unconfigured", async () => {
      const response = await serviceFetch("https://test.local/integration-settings/linear");
      expect(response.status).toBe(200);
      const body = await response.json<{ integrationId: string; settings: unknown }>();
      expect(body.integrationId).toBe("linear");
      expect(body.settings).toBeNull();
    });
  });

  describe("PUT + GET global round-trip", () => {
    it("saves and retrieves global settings", async () => {
      const putRes = await serviceFetch("https://test.local/integration-settings/github", {
        method: "PUT",
        body: JSON.stringify({
          settings: {
            enabledRepos: ["acme/widgets"],
            defaults: { autoReviewOnOpen: false },
          },
        }),
      });
      expect(putRes.status).toBe(200);

      const getRes = await serviceFetch("https://test.local/integration-settings/github");
      expect(getRes.status).toBe(200);
      const body = await getRes.json<{
        integrationId: string;
        settings: {
          enabledRepos: string[];
          defaults: { autoReviewOnOpen: boolean };
        };
      }>();
      expect(body.settings.defaults.autoReviewOnOpen).toBe(false);
      expect(body.settings.enabledRepos).toEqual(["acme/widgets"]);
    });
  });

  describe("DELETE /integration-settings/github", () => {
    it("deletes global settings and reverts to null", async () => {
      // Create settings first
      await serviceFetch("https://test.local/integration-settings/github", {
        method: "PUT",
        body: JSON.stringify({ settings: { defaults: { autoReviewOnOpen: false } } }),
      });

      // Delete
      const delRes = await serviceFetch("https://test.local/integration-settings/github", {
        method: "DELETE",
      });
      expect(delRes.status).toBe(200);
      const delBody = await delRes.json<{ status: string }>();
      expect(delBody.status).toBe("deleted");

      // Verify reverted
      const getRes = await serviceFetch("https://test.local/integration-settings/github");
      const body = await getRes.json<{ settings: unknown }>();
      expect(body.settings).toBeNull();
    });
  });

  describe("per-repo CRUD", () => {
    it("PUT + GET + DELETE round-trip", async () => {
      // Create repo override
      const putRes = await serviceFetch(
        "https://test.local/integration-settings/github/repos/acme/widgets",
        {
          method: "PUT",
          body: JSON.stringify({
            settings: { model: "anthropic/claude-opus-4-6", reasoningEffort: "high" },
          }),
        }
      );
      expect(putRes.status).toBe(200);

      // Read it back
      const getRes = await serviceFetch(
        "https://test.local/integration-settings/github/repos/acme/widgets"
      );
      expect(getRes.status).toBe(200);
      const getBody = await getRes.json<{
        repo: string;
        settings: { model: string; reasoningEffort: string };
      }>();
      expect(getBody.settings.model).toBe("anthropic/claude-opus-4-6");
      expect(getBody.settings.reasoningEffort).toBe("high");

      // List all
      const listRes = await serviceFetch("https://test.local/integration-settings/github/repos");
      expect(listRes.status).toBe(200);
      const listBody = await listRes.json<{ repos: unknown[] }>();
      expect(listBody.repos).toHaveLength(1);

      // Delete
      const delRes = await serviceFetch(
        "https://test.local/integration-settings/github/repos/acme/widgets",
        { method: "DELETE" }
      );
      expect(delRes.status).toBe(200);

      // Verify deleted
      const afterRes = await serviceFetch(
        "https://test.local/integration-settings/github/repos/acme/widgets"
      );
      const afterBody = await afterRes.json<{ settings: unknown }>();
      expect(afterBody.settings).toBeNull();
    });

    it("rejects invalid model ID with 400", async () => {
      const response = await serviceFetch(
        "https://test.local/integration-settings/github/repos/acme/widgets",
        {
          method: "PUT",
          body: JSON.stringify({ settings: { model: "invalid-model-id" } }),
        }
      );
      expect(response.status).toBe(400);
      const body = await response.json<{ error: string }>();
      expect(body.error).toContain("Invalid model ID");
    });
  });

  describe("GET resolved config", () => {
    it("merges global and repo settings", async () => {
      // Set global settings
      await serviceFetch("https://test.local/integration-settings/github", {
        method: "PUT",
        body: JSON.stringify({
          settings: {
            enabledRepos: ["acme/widgets"],
            defaults: { autoReviewOnOpen: false },
          },
        }),
      });

      // Set repo override
      await serviceFetch("https://test.local/integration-settings/github/repos/acme/widgets", {
        method: "PUT",
        body: JSON.stringify({
          settings: { model: "anthropic/claude-opus-4-6", reasoningEffort: "high" },
        }),
      });

      // Get resolved
      const res = await serviceFetch(
        "https://test.local/integration-settings/github/resolved/acme/widgets"
      );
      expect(res.status).toBe(200);
      const body = await res.json<{
        config: {
          model: string;
          reasoningEffort: string;
          autoReviewOnOpen: boolean;
          enabledRepos: string[];
        };
      }>();
      expect(body.config.model).toBe("anthropic/claude-opus-4-6");
      expect(body.config.reasoningEffort).toBe("high");
      expect(body.config.autoReviewOnOpen).toBe(false);
      expect(body.config.enabledRepos).toEqual(["acme/widgets"]);
    });

    it("returns defaults when nothing configured", async () => {
      const res = await serviceFetch(
        "https://test.local/integration-settings/github/resolved/acme/widgets"
      );
      expect(res.status).toBe(200);
      const body = await res.json<{
        config: {
          model: string | null;
          autoReviewOnOpen: boolean;
          enabledRepos: string[] | null;
          allowedTriggerUsers: string[] | null;
          codeReviewInstructions: string | null;
          commentActionInstructions: string | null;
        };
      }>();
      expect(body.config.model).toBeNull();
      expect(body.config.autoReviewOnOpen).toBe(true);
      expect(body.config.enabledRepos).toBeNull();
      expect(body.config.allowedTriggerUsers).toBeNull();
      expect(body.config.codeReviewInstructions).toBeNull();
      expect(body.config.commentActionInstructions).toBeNull();
    });

    it("returns allowedTriggerUsers in resolved config from defaults", async () => {
      await serviceFetch("https://test.local/integration-settings/github", {
        method: "PUT",
        body: JSON.stringify({
          settings: {
            defaults: { allowedTriggerUsers: ["Alice", "bob"] },
          },
        }),
      });

      const res = await serviceFetch(
        "https://test.local/integration-settings/github/resolved/acme/widgets"
      );
      expect(res.status).toBe(200);
      const body = await res.json<{
        config: {
          allowedTriggerUsers: string[] | null;
        };
      }>();
      expect(body.config.allowedTriggerUsers).toEqual(["alice", "bob"]);
    });

    it("round-trips codeReviewInstructions through resolved endpoint", async () => {
      await serviceFetch("https://test.local/integration-settings/github", {
        method: "PUT",
        body: JSON.stringify({
          settings: {
            defaults: { codeReviewInstructions: "Focus on security." },
          },
        }),
      });

      const res = await serviceFetch(
        "https://test.local/integration-settings/github/resolved/acme/widgets"
      );
      expect(res.status).toBe(200);
      const body = await res.json<{
        config: { codeReviewInstructions: string | null };
      }>();
      expect(body.config.codeReviewInstructions).toBe("Focus on security.");
    });

    it("repo override codeReviewInstructions wins over global default", async () => {
      await serviceFetch("https://test.local/integration-settings/github", {
        method: "PUT",
        body: JSON.stringify({
          settings: {
            defaults: { codeReviewInstructions: "Global instructions." },
          },
        }),
      });

      await serviceFetch("https://test.local/integration-settings/github/repos/acme/widgets", {
        method: "PUT",
        body: JSON.stringify({
          settings: { codeReviewInstructions: "Repo-specific instructions." },
        }),
      });

      const res = await serviceFetch(
        "https://test.local/integration-settings/github/resolved/acme/widgets"
      );
      expect(res.status).toBe(200);
      const body = await res.json<{
        config: { codeReviewInstructions: string | null };
      }>();
      expect(body.config.codeReviewInstructions).toBe("Repo-specific instructions.");
    });

    it("per-repo allowedTriggerUsers overrides global default", async () => {
      await serviceFetch("https://test.local/integration-settings/github", {
        method: "PUT",
        body: JSON.stringify({
          settings: {
            defaults: { allowedTriggerUsers: ["alice", "bob"] },
          },
        }),
      });

      await serviceFetch("https://test.local/integration-settings/github/repos/acme/widgets", {
        method: "PUT",
        body: JSON.stringify({
          settings: { allowedTriggerUsers: ["carol"] },
        }),
      });

      const res = await serviceFetch(
        "https://test.local/integration-settings/github/resolved/acme/widgets"
      );
      expect(res.status).toBe(200);
      const body = await res.json<{
        config: {
          allowedTriggerUsers: string[] | null;
        };
      }>();
      expect(body.config.allowedTriggerUsers).toEqual(["carol"]);
    });

    it("returns linear resolved config with merged defaults", async () => {
      await serviceFetch("https://test.local/integration-settings/linear", {
        method: "PUT",
        body: JSON.stringify({
          settings: {
            enabledRepos: ["acme/widgets"],
            defaults: {
              model: "anthropic/claude-sonnet-4-6",
              reasoningEffort: "high",
              allowUserPreferenceOverride: true,
              allowLabelModelOverride: true,
              emitToolProgressActivities: true,
            },
          },
        }),
      });

      await serviceFetch("https://test.local/integration-settings/linear/repos/acme/widgets", {
        method: "PUT",
        body: JSON.stringify({
          settings: {
            allowUserPreferenceOverride: false,
          },
        }),
      });

      const res = await serviceFetch(
        "https://test.local/integration-settings/linear/resolved/acme/widgets"
      );
      expect(res.status).toBe(200);
      const body = await res.json<{
        config: {
          model: string;
          reasoningEffort: string;
          allowUserPreferenceOverride: boolean;
          allowLabelModelOverride: boolean;
          emitToolProgressActivities: boolean;
          enabledRepos: string[] | null;
        };
      }>();

      expect(body.config.model).toBe("anthropic/claude-sonnet-4-6");
      expect(body.config.reasoningEffort).toBe("high");
      expect(body.config.allowUserPreferenceOverride).toBe(false);
      expect(body.config.allowLabelModelOverride).toBe(true);
      expect(body.config.emitToolProgressActivities).toBe(true);
      expect(body.config.enabledRepos).toEqual(["acme/widgets"]);
    });

    it("returns linear defaults when unconfigured", async () => {
      const res = await serviceFetch(
        "https://test.local/integration-settings/linear/resolved/acme/widgets"
      );
      expect(res.status).toBe(200);
      const body = await res.json<{
        config: {
          model: string | null;
          reasoningEffort: string | null;
          allowUserPreferenceOverride: boolean;
          allowLabelModelOverride: boolean;
          emitToolProgressActivities: boolean;
          enabledRepos: string[] | null;
        };
      }>();

      expect(body.config.model).toBeNull();
      expect(body.config.reasoningEffort).toBeNull();
      expect(body.config.allowUserPreferenceOverride).toBe(true);
      expect(body.config.allowLabelModelOverride).toBe(true);
      expect(body.config.emitToolProgressActivities).toBe(true);
      expect(body.config.enabledRepos).toBeNull();
    });

    it("returns code-server resolved config with defaults when unconfigured", async () => {
      const res = await serviceFetch(
        "https://test.local/integration-settings/code-server/resolved/acme/widgets"
      );
      expect(res.status).toBe(200);
      const body = await res.json<{
        config: {
          enabled: boolean;
          enabledRepos: string[] | null;
        };
      }>();

      expect(body.config.enabled).toBe(false);
      expect(body.config.enabledRepos).toBeNull();
    });

    it("returns code-server resolved config with merged settings", async () => {
      // Set global: enabled with repo scope
      await serviceFetch("https://test.local/integration-settings/code-server", {
        method: "PUT",
        body: JSON.stringify({
          settings: {
            enabledRepos: ["acme/widgets"],
            defaults: { enabled: true },
          },
        }),
      });

      // Repo override disables for this specific repo
      await serviceFetch("https://test.local/integration-settings/code-server/repos/acme/widgets", {
        method: "PUT",
        body: JSON.stringify({
          settings: { enabled: false },
        }),
      });

      const res = await serviceFetch(
        "https://test.local/integration-settings/code-server/resolved/acme/widgets"
      );
      expect(res.status).toBe(200);
      const body = await res.json<{
        config: {
          enabled: boolean;
          enabledRepos: string[];
        };
      }>();

      // Repo override wins
      expect(body.config.enabled).toBe(false);
      expect(body.config.enabledRepos).toEqual(["acme/widgets"]);
    });
  });

  describe("sandbox settings API", () => {
    it("GET /integration-settings/sandbox returns null settings when unconfigured", async () => {
      const response = await serviceFetch("https://test.local/integration-settings/sandbox");
      expect(response.status).toBe(200);
      const body = await response.json<{ integrationId: string; settings: unknown }>();
      expect(body.integrationId).toBe("sandbox");
      expect(body.settings).toBeNull();
    });

    it("PUT + GET /integration-settings/sandbox global round-trip", async () => {
      const putRes = await serviceFetch("https://test.local/integration-settings/sandbox", {
        method: "PUT",
        body: JSON.stringify({
          settings: {
            defaults: { tunnelPorts: [3000] },
          },
        }),
      });
      expect(putRes.status).toBe(200);

      const getRes = await serviceFetch("https://test.local/integration-settings/sandbox");
      expect(getRes.status).toBe(200);
      const body = await getRes.json<{
        settings: {
          defaults: { tunnelPorts: number[] };
        };
      }>();
      expect(body.settings.defaults.tunnelPorts).toEqual([3000]);
    });

    it("PUT /integration-settings/sandbox with invalid tunnelPorts returns 400", async () => {
      const response = await serviceFetch(
        "https://test.local/integration-settings/sandbox/repos/acme/widgets",
        {
          method: "PUT",
          body: JSON.stringify({ settings: { tunnelPorts: "not-an-array" } }),
        }
      );
      expect(response.status).toBe(400);
      const body = await response.json<{ error: string }>();
      expect(body.error).toContain("tunnelPorts must be an array");
    });

    it("GET /integration-settings/sandbox/resolved returns default empty tunnelPorts when unconfigured", async () => {
      const res = await serviceFetch(
        "https://test.local/integration-settings/sandbox/resolved/testowner/testrepo"
      );
      expect(res.status).toBe(200);
      const body = await res.json<{
        config: {
          tunnelPorts: number[];
          maxConcurrentChildSessions: number;
          maxTotalChildSessions: number;
          cpuCores: number | null;
          memoryMib: number | null;
          enabledRepos: string[] | null;
        };
      }>();
      expect(body.config.tunnelPorts).toEqual([]);
      expect(body.config.maxConcurrentChildSessions).toBe(DEFAULT_MAX_CONCURRENT_CHILD_SESSIONS);
      expect(body.config.maxTotalChildSessions).toBe(DEFAULT_MAX_TOTAL_CHILD_SESSIONS);
      // Unset resource reservations resolve to null → provider default applies.
      expect(body.config.cpuCores).toBeNull();
      expect(body.config.memoryMib).toBeNull();
      expect(body.config.enabledRepos).toBeNull();
    });

    it("GET /integration-settings/sandbox/resolved returns configured cpuCores and memoryMib", async () => {
      const putRes = await serviceFetch("https://test.local/integration-settings/sandbox", {
        method: "PUT",
        body: JSON.stringify({
          settings: {
            defaults: { cpuCores: 2, memoryMib: 4096 },
          },
        }),
      });
      expect(putRes.status).toBe(200);

      const res = await serviceFetch(
        "https://test.local/integration-settings/sandbox/resolved/testowner/testrepo"
      );
      expect(res.status).toBe(200);
      const body = await res.json<{
        config: {
          cpuCores: number | null;
          memoryMib: number | null;
        };
      }>();
      expect(body.config.cpuCores).toBe(2);
      expect(body.config.memoryMib).toBe(4096);
    });

    it("GET /integration-settings/sandbox/resolved preserves null repo resource overrides", async () => {
      const putGlobalRes = await serviceFetch("https://test.local/integration-settings/sandbox", {
        method: "PUT",
        body: JSON.stringify({
          settings: {
            defaults: { cpuCores: 2, memoryMib: 4096 },
          },
        }),
      });
      expect(putGlobalRes.status).toBe(200);

      const putRepoRes = await serviceFetch(
        "https://test.local/integration-settings/sandbox/repos/testowner/testrepo",
        {
          method: "PUT",
          body: JSON.stringify({
            settings: { cpuCores: null, memoryMib: null },
          }),
        }
      );
      expect(putRepoRes.status).toBe(200);

      const res = await serviceFetch(
        "https://test.local/integration-settings/sandbox/resolved/testowner/testrepo"
      );
      expect(res.status).toBe(200);
      const body = await res.json<{
        config: {
          cpuCores: number | null;
          memoryMib: number | null;
        };
      }>();
      expect(body.config.cpuCores).toBeNull();
      expect(body.config.memoryMib).toBeNull();
    });
  });

  describe("code-server CRUD", () => {
    it("GET returns null settings when unconfigured", async () => {
      const response = await serviceFetch("https://test.local/integration-settings/code-server");
      expect(response.status).toBe(200);
      const body = await response.json<{ integrationId: string; settings: unknown }>();
      expect(body.integrationId).toBe("code-server");
      expect(body.settings).toBeNull();
    });

    it("PUT + GET round-trip for global settings", async () => {
      const putRes = await serviceFetch("https://test.local/integration-settings/code-server", {
        method: "PUT",
        body: JSON.stringify({
          settings: {
            enabledRepos: ["acme/widgets"],
            defaults: { enabled: true },
          },
        }),
      });
      expect(putRes.status).toBe(200);

      const getRes = await serviceFetch("https://test.local/integration-settings/code-server");
      expect(getRes.status).toBe(200);
      const body = await getRes.json<{
        settings: {
          enabledRepos: string[];
          defaults: { enabled: boolean };
        };
      }>();
      expect(body.settings.defaults.enabled).toBe(true);
      expect(body.settings.enabledRepos).toEqual(["acme/widgets"]);
    });

    it("rejects non-boolean enabled with 400", async () => {
      const response = await serviceFetch(
        "https://test.local/integration-settings/code-server/repos/acme/widgets",
        {
          method: "PUT",
          body: JSON.stringify({ settings: { enabled: "yes" } }),
        }
      );
      expect(response.status).toBe(400);
      const body = await response.json<{ error: string }>();
      expect(body.error).toContain("enabled must be a boolean");
    });
  });

  describe("environment-level settings (design §13.5)", () => {
    async function seedEnvironment(id: string): Promise<void> {
      const store = new EnvironmentStore(env.DB);
      const now = Date.now();
      await store.create(
        {
          id,
          name: `Env ${id}`,
          description: null,
          prebuild_enabled: 0,
          channel_associations: null,
          created_at: now,
          updated_at: now,
        },
        [{ position: 0, repo_owner: "acme", repo_name: "web", repo_id: 1, base_branch: "main" }]
      );
    }

    it("PUT + GET + DELETE round-trip for sandbox environment overrides", async () => {
      await seedEnvironment("env_settings1");

      const putRes = await serviceFetch(
        "https://test.local/integration-settings/sandbox/environments/env_settings1",
        {
          method: "PUT",
          body: JSON.stringify({ settings: { buildTimeoutSeconds: 2400, terminalEnabled: true } }),
        }
      );
      expect(putRes.status).toBe(200);

      const getRes = await serviceFetch(
        "https://test.local/integration-settings/sandbox/environments/env_settings1"
      );
      expect(getRes.status).toBe(200);
      const body = await getRes.json<{
        integrationId: string;
        environmentId: string;
        settings: { buildTimeoutSeconds: number; terminalEnabled: boolean };
      }>();
      expect(body.integrationId).toBe("sandbox");
      expect(body.environmentId).toBe("env_settings1");
      expect(body.settings).toEqual({ buildTimeoutSeconds: 2400, terminalEnabled: true });

      const deleteRes = await serviceFetch(
        "https://test.local/integration-settings/sandbox/environments/env_settings1",
        { method: "DELETE" }
      );
      expect(deleteRes.status).toBe(200);

      const afterDelete = await serviceFetch(
        "https://test.local/integration-settings/sandbox/environments/env_settings1"
      );
      const afterDeleteBody = await afterDelete.json<{ settings: unknown }>();
      expect(afterDeleteBody.settings).toBeNull();
    });

    it("returns 404 for an environment that does not exist", async () => {
      const response = await serviceFetch(
        "https://test.local/integration-settings/sandbox/environments/env_missing",
        {
          method: "PUT",
          body: JSON.stringify({ settings: { terminalEnabled: true } }),
        }
      );
      expect(response.status).toBe(404);
      const body = await response.json<{ error: string }>();
      expect(body.error).toContain("Environment not found");
    });

    it("returns 400 for integrations without environment-level support", async () => {
      await seedEnvironment("env_settings2");

      const response = await serviceFetch(
        "https://test.local/integration-settings/github/environments/env_settings2",
        {
          method: "PUT",
          body: JSON.stringify({ settings: { autoReviewOnOpen: false } }),
        }
      );
      expect(response.status).toBe(400);
      const body = await response.json<{ error: string }>();
      expect(body.error).toContain("does not support environment-level settings");
    });

    it("rejects invalid sandbox settings with 400", async () => {
      await seedEnvironment("env_settings3");

      const response = await serviceFetch(
        "https://test.local/integration-settings/sandbox/environments/env_settings3",
        {
          method: "PUT",
          body: JSON.stringify({ settings: { tunnelPorts: [70000] } }),
        }
      );
      expect(response.status).toBe(400);
    });

    it("cascades settings deletion when the environment is deleted", async () => {
      await seedEnvironment("env_settings4");

      const putRes = await serviceFetch(
        "https://test.local/integration-settings/code-server/environments/env_settings4",
        {
          method: "PUT",
          body: JSON.stringify({ settings: { enabled: true } }),
        }
      );
      expect(putRes.status).toBe(200);

      await new EnvironmentStore(env.DB).delete("env_settings4");

      const row = await env.DB.prepare(
        "SELECT settings FROM integration_environment_settings WHERE environment_id = ?"
      )
        .bind("env_settings4")
        .first();
      expect(row).toBeNull();
    });
  });
});

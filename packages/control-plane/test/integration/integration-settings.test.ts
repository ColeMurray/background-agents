import { describe, it, expect, beforeEach } from "vitest";
import { SELF, env } from "cloudflare:test";
import { generateInternalToken } from "../../src/auth/internal";
import { cleanD1Tables } from "./cleanup";

async function authHeaders(): Promise<Record<string, string>> {
  const token = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET!);
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

describe("Integration settings API", () => {
  beforeEach(cleanD1Tables);

  describe("auth", () => {
    it("returns 401 without auth header", async () => {
      const response = await SELF.fetch("https://test.local/integration-settings/github", {
        headers: { "Content-Type": "application/json" },
      });
      expect(response.status).toBe(401);
    });
  });

  describe("unknown integration ID", () => {
    it("returns 404 for unknown integration", async () => {
      const headers = await authHeaders();
      const response = await SELF.fetch("https://test.local/integration-settings/unknownthing", {
        headers,
      });
      expect(response.status).toBe(404);
      const body = await response.json<{ error: string }>();
      expect(body.error).toContain("Unknown integration");
    });
  });

  describe("GET /integration-settings/github", () => {
    it("returns null settings when unconfigured", async () => {
      const headers = await authHeaders();
      const response = await SELF.fetch("https://test.local/integration-settings/github", {
        headers,
      });
      expect(response.status).toBe(200);
      const body = await response.json<{ integrationId: string; settings: unknown }>();
      expect(body.integrationId).toBe("github");
      expect(body.settings).toBeNull();
    });
  });

  describe("GET /integration-settings/linear", () => {
    it("returns null settings when unconfigured", async () => {
      const headers = await authHeaders();
      const response = await SELF.fetch("https://test.local/integration-settings/linear", {
        headers,
      });
      expect(response.status).toBe(200);
      const body = await response.json<{ integrationId: string; settings: unknown }>();
      expect(body.integrationId).toBe("linear");
      expect(body.settings).toBeNull();
    });
  });

  describe("PUT + GET global round-trip", () => {
    it("saves and retrieves global settings", async () => {
      const headers = await authHeaders();

      const putRes = await SELF.fetch("https://test.local/integration-settings/github", {
        method: "PUT",
        headers,
        body: JSON.stringify({
          settings: {
            enabledRepos: ["acme/widgets"],
            defaults: { autoReviewOnOpen: false },
          },
        }),
      });
      expect(putRes.status).toBe(200);

      const getRes = await SELF.fetch("https://test.local/integration-settings/github", {
        headers,
      });
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
      const headers = await authHeaders();

      // Create settings first
      await SELF.fetch("https://test.local/integration-settings/github", {
        method: "PUT",
        headers,
        body: JSON.stringify({ settings: { defaults: { autoReviewOnOpen: false } } }),
      });

      // Delete
      const delRes = await SELF.fetch("https://test.local/integration-settings/github", {
        method: "DELETE",
        headers,
      });
      expect(delRes.status).toBe(200);
      const delBody = await delRes.json<{ status: string }>();
      expect(delBody.status).toBe("deleted");

      // Verify reverted
      const getRes = await SELF.fetch("https://test.local/integration-settings/github", {
        headers,
      });
      const body = await getRes.json<{ settings: unknown }>();
      expect(body.settings).toBeNull();
    });
  });

  describe("per-repo CRUD", () => {
    it("PUT + GET + DELETE round-trip", async () => {
      const headers = await authHeaders();

      // Create repo override
      const putRes = await SELF.fetch(
        "https://test.local/integration-settings/github/repos/acme/widgets",
        {
          method: "PUT",
          headers,
          body: JSON.stringify({
            settings: { model: "anthropic/claude-opus-4-6", reasoningEffort: "high" },
          }),
        }
      );
      expect(putRes.status).toBe(200);

      // Read it back
      const getRes = await SELF.fetch(
        "https://test.local/integration-settings/github/repos/acme/widgets",
        { headers }
      );
      expect(getRes.status).toBe(200);
      const getBody = await getRes.json<{
        repo: string;
        settings: { model: string; reasoningEffort: string };
      }>();
      expect(getBody.settings.model).toBe("anthropic/claude-opus-4-6");
      expect(getBody.settings.reasoningEffort).toBe("high");

      // List all
      const listRes = await SELF.fetch("https://test.local/integration-settings/github/repos", {
        headers,
      });
      expect(listRes.status).toBe(200);
      const listBody = await listRes.json<{ repos: unknown[] }>();
      expect(listBody.repos).toHaveLength(1);

      // Delete
      const delRes = await SELF.fetch(
        "https://test.local/integration-settings/github/repos/acme/widgets",
        { method: "DELETE", headers }
      );
      expect(delRes.status).toBe(200);

      // Verify deleted
      const afterRes = await SELF.fetch(
        "https://test.local/integration-settings/github/repos/acme/widgets",
        { headers }
      );
      const afterBody = await afterRes.json<{ settings: unknown }>();
      expect(afterBody.settings).toBeNull();
    });

    it("rejects invalid model ID with 400", async () => {
      const headers = await authHeaders();
      const response = await SELF.fetch(
        "https://test.local/integration-settings/github/repos/acme/widgets",
        {
          method: "PUT",
          headers,
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
      const headers = await authHeaders();

      // Set global settings
      await SELF.fetch("https://test.local/integration-settings/github", {
        method: "PUT",
        headers,
        body: JSON.stringify({
          settings: {
            enabledRepos: ["acme/widgets"],
            defaults: { autoReviewOnOpen: false },
          },
        }),
      });

      // Set repo override
      await SELF.fetch("https://test.local/integration-settings/github/repos/acme/widgets", {
        method: "PUT",
        headers,
        body: JSON.stringify({
          settings: { model: "anthropic/claude-opus-4-6", reasoningEffort: "high" },
        }),
      });

      // Get resolved
      const res = await SELF.fetch(
        "https://test.local/integration-settings/github/resolved/acme/widgets",
        { headers }
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
      const headers = await authHeaders();
      const res = await SELF.fetch(
        "https://test.local/integration-settings/github/resolved/acme/widgets",
        { headers }
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
      const headers = await authHeaders();

      await SELF.fetch("https://test.local/integration-settings/github", {
        method: "PUT",
        headers,
        body: JSON.stringify({
          settings: {
            defaults: { allowedTriggerUsers: ["Alice", "bob"] },
          },
        }),
      });

      const res = await SELF.fetch(
        "https://test.local/integration-settings/github/resolved/acme/widgets",
        { headers }
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
      const headers = await authHeaders();

      await SELF.fetch("https://test.local/integration-settings/github", {
        method: "PUT",
        headers,
        body: JSON.stringify({
          settings: {
            defaults: { codeReviewInstructions: "Focus on security." },
          },
        }),
      });

      const res = await SELF.fetch(
        "https://test.local/integration-settings/github/resolved/acme/widgets",
        { headers }
      );
      expect(res.status).toBe(200);
      const body = await res.json<{
        config: { codeReviewInstructions: string | null };
      }>();
      expect(body.config.codeReviewInstructions).toBe("Focus on security.");
    });

    it("repo override codeReviewInstructions wins over global default", async () => {
      const headers = await authHeaders();

      await SELF.fetch("https://test.local/integration-settings/github", {
        method: "PUT",
        headers,
        body: JSON.stringify({
          settings: {
            defaults: { codeReviewInstructions: "Global instructions." },
          },
        }),
      });

      await SELF.fetch("https://test.local/integration-settings/github/repos/acme/widgets", {
        method: "PUT",
        headers,
        body: JSON.stringify({
          settings: { codeReviewInstructions: "Repo-specific instructions." },
        }),
      });

      const res = await SELF.fetch(
        "https://test.local/integration-settings/github/resolved/acme/widgets",
        { headers }
      );
      expect(res.status).toBe(200);
      const body = await res.json<{
        config: { codeReviewInstructions: string | null };
      }>();
      expect(body.config.codeReviewInstructions).toBe("Repo-specific instructions.");
    });

    it("per-repo allowedTriggerUsers overrides global default", async () => {
      const headers = await authHeaders();

      await SELF.fetch("https://test.local/integration-settings/github", {
        method: "PUT",
        headers,
        body: JSON.stringify({
          settings: {
            defaults: { allowedTriggerUsers: ["alice", "bob"] },
          },
        }),
      });

      await SELF.fetch("https://test.local/integration-settings/github/repos/acme/widgets", {
        method: "PUT",
        headers,
        body: JSON.stringify({
          settings: { allowedTriggerUsers: ["carol"] },
        }),
      });

      const res = await SELF.fetch(
        "https://test.local/integration-settings/github/resolved/acme/widgets",
        { headers }
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
      const headers = await authHeaders();

      await SELF.fetch("https://test.local/integration-settings/linear", {
        method: "PUT",
        headers,
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

      await SELF.fetch("https://test.local/integration-settings/linear/repos/acme/widgets", {
        method: "PUT",
        headers,
        body: JSON.stringify({
          settings: {
            allowUserPreferenceOverride: false,
          },
        }),
      });

      const res = await SELF.fetch(
        "https://test.local/integration-settings/linear/resolved/acme/widgets",
        { headers }
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
      const headers = await authHeaders();
      const res = await SELF.fetch(
        "https://test.local/integration-settings/linear/resolved/acme/widgets",
        { headers }
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
  });
});

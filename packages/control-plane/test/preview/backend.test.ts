import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startPreviewBackend, type PreviewBackend } from "./backend";
import { expectJson, waitFor } from "./scenarios";
import { buildServiceAuthHeaders } from "@open-inspect/shared/service-auth";
import type { BrowserCookie } from "../support/browser-session";

const root = resolve(import.meta.dirname, "../../../..");
describe("real authenticated preview backend", () => {
  let backend: PreviewBackend | undefined;
  let runDir: string | undefined;
  afterEach(async () => {
    try {
      await backend?.close();
    } finally {
      if (runDir) await rm(runDir, { recursive: true, force: true });
    }
    backend = undefined;
  });
  async function start(scenario: "empty" | "populated" = "empty", inactivityTimeoutMs?: number) {
    runDir = await mkdtemp(join(tmpdir(), "oi-preview-test-"));
    backend = await startPreviewBackend({
      root,
      runDir,
      webOrigin: "http://127.0.0.1:3100",
      scenario,
      inactivityTimeoutMs,
    });
    return backend;
  }
  it("authenticates canonical personas and rejects unauthorized mutations and logout reuse", async () => {
    const b = await start();
    for (const persona of ["member", "owner", "viewer", "suspended"] as const) {
      const auth = await expectJson<{ user: { id: string } }>(
        await b.request("/api/auth/get-session", { persona })
      );
      expect(auth.user.id).toBe(b.identities[persona].userId);
      expect((await b.request("/me/authorization", { persona })).status).toBe(200);
    }
    for (const persona of ["viewer", "suspended"] as const) {
      expect(
        (await b.request("/sessions", { method: "POST", body: { name: "denied" }, persona })).status
      ).toBe(403);
    }
    for (const persona of ["anonymous", "expired"] as const)
      expect((await b.request("/sessions", { persona })).status).toBe(401);
    expect(
      (
        await fetch(`${b.origin}/sessions`, {
          headers: { Cookie: b.identities.member.cookieHeader },
        })
      ).status
    ).toBe(401);
    const url = `${b.origin}/sessions`;
    const wrongSignature = await buildServiceAuthHeaders({
      service: "web",
      secret: "incorrect-preview-service-secret",
      method: "GET",
      url,
    });
    expect(
      (
        await fetch(url, {
          headers: { ...wrongSignature, Cookie: b.identities.member.cookieHeader },
        })
      ).status
    ).toBe(401);
    expect((await b.request("/api/auth/sign-out", { method: "POST", body: {} })).status).toBe(200);
    expect((await b.request("/sessions")).status).toBe(401);
  }, 30_000);
  it("signs personas in again after sign-out, and never authenticates expired or anonymous", async () => {
    const b = await start();
    const sessionUser = async (cookie: BrowserCookie) => {
      const url = `${b.origin}/api/auth/get-session`;
      const response = await fetch(url, {
        headers: {
          ...(await buildServiceAuthHeaders({
            service: "web",
            secret: b.config.SERVICE_AUTH_SECRET_WEB!,
            method: "GET",
            url,
          })),
          Cookie: `${cookie.name}=${cookie.value}`,
        },
      });
      expect(response.status).toBe(200);
      return ((await response.json()) as { user: { id: string } } | null)?.user.id ?? null;
    };
    expect((await b.request("/api/auth/sign-out", { method: "POST", body: {} })).status).toBe(200);
    expect((await b.request("/sessions")).status).toBe(401);
    const member = await b.signIn("member");
    expect(member.value).not.toBe(b.identities.member.storageState.cookies[0].value);
    expect(await sessionUser(member)).toBe(b.identities.member.userId);
    expect(await sessionUser(await b.signIn("owner"))).toBe(b.identities.owner.userId);
    for (const persona of ["expired", "anonymous"] as const) {
      const cookie = await b.signIn(persona);
      expect(cookie.expires * 1000).toBeLessThan(Date.now());
      expect(await sessionUser(cookie)).toBeNull();
    }
  }, 30_000);
  it("completes turns on every provider's models, not only the default Anthropic one", async () => {
    const b = await start();
    for (const model of ["openai/gpt-5.5", "xai/grok-4.7"]) {
      const { sessionId } = await expectJson<{ sessionId: string }>(
        await b.request("/sessions", {
          method: "POST",
          body: { repoOwner: "preview-org", repoName: "preview-app", model },
        })
      );
      const { messageId } = await expectJson<{ messageId: string }>(
        await b.request(`/sessions/${sessionId}/prompt`, {
          method: "POST",
          body: { content: `A turn on ${model}.` },
        })
      );
      const settled = await waitFor(`${model} turn to settle`, async () => {
        const { messages } = await expectJson<{
          messages: Array<{ id: string; status: string }>;
        }>(await b.request(`/sessions/${sessionId}/messages`));
        const message = messages.find((m) => m.id === messageId);
        return message && message.status !== "pending" && message.status !== "processing"
          ? message
          : false;
      });
      expect(settled, model).toMatchObject({ status: "completed" });
    }
    expect(b.failures()).toEqual([]);
  }, 30_000);
  it("creates persisted history, idles through preservation and restores for another turn", async () => {
    const b = await start("populated", 2000);
    const sessionId = b.aliases.completedSession;
    await waitFor(
      "actual fixture stop",
      async () => (b.modal.state.stops > 0 && b.modal.activeBridges === 0) || false,
      45_000
    );
    expect(b.modal.state.preservations).toBeGreaterThan(0);
    expect(b.modal.state.snapshots).toBeGreaterThan(0);
    await waitFor("saved preservation state", async () => {
      const data = await expectJson<{ session: { sandboxPreservation?: { phase: string } } }>(
        await b.request(`/sessions/${sessionId}`)
      );
      return data.session.sandboxPreservation?.phase === "saved" || false;
    });
    const { messageId } = await expectJson<{ messageId: string }>(
      await b.request(`/sessions/${sessionId}/prompt`, {
        method: "POST",
        body: { content: "A second turn after idle." },
      })
    );
    await waitFor("restored completion", async () => {
      const { messages } = await expectJson<{ messages: Array<{ id: string; status: string }> }>(
        await b.request(`/sessions/${sessionId}/messages`)
      );
      return messages.some((m) => m.id === messageId && m.status === "completed") || false;
    });
    expect(b.modal.state.restores).toBe(1);
    expect(b.modal.state.generationHandshakes).toBe(2);
    expect(b.failures()).toEqual([]);
  }, 60_000);
});

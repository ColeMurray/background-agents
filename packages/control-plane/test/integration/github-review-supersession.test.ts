import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { GitHubPrReviewStore } from "../../src/db/github-pr-review-store";
import { SessionIndexStore } from "../../src/db/session-index";
import { UserStore } from "../../src/db/user-store";
import { cleanD1Tables } from "./cleanup";
import { initSession, serviceFetch, sqlDatabase } from "./helpers";

const BASE = "https://test.local";
const URL = `${BASE}/internal/github-reviews/supersede`;
const REPOSITORY_ID = 99;
const PULL_NUMBER = 42;

function claim(sessionId: string, pullNumber = PULL_NUMBER, repositoryId = REPOSITORY_ID) {
  return serviceFetch(URL, {
    service: "github-bot",
    method: "POST",
    body: JSON.stringify({ sessionId, repositoryId, pullNumber }),
  });
}

describe("POST /internal/github-reviews/supersede", () => {
  beforeEach(() => cleanD1Tables());

  it("cancels the review it replaces and refuses that session's prompt", async () => {
    const first = await initSession({ sessionName: "review-a" });
    const second = await initSession({ sessionName: "review-b" });

    const initial = await claim(first.sessionName);
    expect(initial.status).toBe(200);
    expect(initial.headers.get("Cache-Control")).toBe("private, no-store");
    await expect(initial.json()).resolves.toEqual({ displacedSessionIds: [] });

    const again = await claim(first.sessionName);
    expect(again.status).toBe(200);
    await expect(again.json()).resolves.toEqual({ displacedSessionIds: [] });
    expect((await new SessionIndexStore(env.DB).get(first.sessionName))?.status).toBe("created");

    const replaced = await claim(second.sessionName);
    expect(replaced.status).toBe(200);
    await expect(replaced.json()).resolves.toEqual({ displacedSessionIds: ["review-a"] });

    expect((await new SessionIndexStore(env.DB).get(first.sessionName))?.status).toBe("cancelled");
    expect((await new SessionIndexStore(env.DB).get(second.sessionName))?.status).toBe("created");
    const store = new GitHubPrReviewStore(sqlDatabase(env.DB));
    await expect(store.isSuperseded(first.sessionName)).resolves.toBe(true);
    await expect(store.isSuperseded(second.sessionName)).resolves.toBe(false);

    const otherPull = await initSession({ sessionName: "review-c" });
    const separate = await claim(otherPull.sessionName, PULL_NUMBER + 1);
    expect(separate.status).toBe(200);
    await expect(separate.json()).resolves.toEqual({ displacedSessionIds: [] });
    expect((await new SessionIndexStore(env.DB).get(second.sessionName))?.status).toBe("created");

    const prompt = await serviceFetch(`${BASE}/sessions/${first.sessionName}/prompt`, {
      method: "POST",
      body: JSON.stringify({ content: "continue the old review", source: "github" }),
    });
    expect(prompt.status).toBe(409);
    await expect(prompt.json()).resolves.toMatchObject({ code: "review_superseded" });
  });

  it("rejects an actor and every service other than the github bot", async () => {
    const body = JSON.stringify({
      sessionId: "review-a",
      repositoryId: REPOSITORY_ID,
      pullNumber: PULL_NUMBER,
    });
    const actor = await serviceFetch(URL, {
      service: "github-bot",
      method: "POST",
      actor: "github:101",
      body,
    });
    expect(actor.status).toBe(403);
    expect(await new UserStore(env.DB).getIdentity("github", "101")).toBeNull();

    const slack = await serviceFetch(URL, { service: "slack-bot", method: "POST", body });
    expect(slack.status).toBe(403);

    const anonymous = await SELF.fetch(URL, {
      method: "POST",
      body,
      headers: { "Content-Type": "application/json" },
    });
    expect(anonymous.status).toBe(401);

    const invalid = await serviceFetch(URL, {
      service: "github-bot",
      method: "POST",
      body: JSON.stringify({ sessionId: "", repositoryId: 0, pullNumber: 1 }),
    });
    expect(invalid.status).toBe(400);
  });
});

import { describe, it, expect } from "vitest";
import { normalizeGitHubEvent } from "./normalizer";
import { automationEventSchema, githubAutomationEventSchema } from "../types";
import {
  repo,
  sender,
  basePR,
  pullRequestOpenedPayload,
  CATALOG_PAYLOADS,
} from "../../../test-fixtures/github-webhook-payloads";

describe("GitHub sender kind", () => {
  it.each(
    Object.entries(CATALOG_PAYLOADS).flatMap(([eventType, raw]) => [
      [eventType, "User", "person", raw] as const,
      [eventType, "Bot", "bot", raw] as const,
    ])
  )("%s reports a %s sender as a %s", (_eventType, type, actorKind, [header, payload]) => {
    const event = normalizeGitHubEvent(header, {
      ...payload,
      sender: { login: "sender", type },
    });
    expect(event).toMatchObject({ actor: "sender", actorKind });
    expect(githubAutomationEventSchema.parse(event)).toEqual(event);
  });

  it.each(["Organization", "Mannequin", undefined, null, 7])(
    "reports no kind for a %s sender rather than guessing",
    (type) => {
      const event = normalizeGitHubEvent("pull_request", {
        ...pullRequestOpenedPayload,
        sender: { login: "someone", type },
      });
      expect(event).toMatchObject({ actor: "someone" });
      expect(event?.actorKind).toBeUndefined();
    }
  );

  it("ignores the type of users other than the sender", () => {
    const event = normalizeGitHubEvent("pull_request", {
      ...pullRequestOpenedPayload,
      pull_request: { ...basePR, user: { login: "author", type: null } },
    });
    expect(event).toMatchObject({ actor: sender.login, actorKind: "person" });
  });

  // github-bot and the control plane deploy independently: a consumer must drop
  // a field a newer producer adds, as an older one drops actorKind.
  it("strips fields a newer producer adds rather than rejecting the event", () => {
    const event = normalizeGitHubEvent("pull_request", pullRequestOpenedPayload)!;
    expect(automationEventSchema.parse({ ...event, addedLater: true })).toEqual(event);
  });

  it("does not infer a bot from the login alone", () => {
    const event = normalizeGitHubEvent("pull_request", {
      ...pullRequestOpenedPayload,
      sender: { login: "renovate[bot]" },
    });
    expect(event?.actorKind).toBeUndefined();
  });

  it("reports no kind when the payload has no sender", () => {
    const event = normalizeGitHubEvent("pull_request", {
      ...pullRequestOpenedPayload,
      sender: undefined,
    });
    expect(event).toMatchObject({ repositoryId: repo.id });
    expect(event?.actorKind).toBeUndefined();
  });
});

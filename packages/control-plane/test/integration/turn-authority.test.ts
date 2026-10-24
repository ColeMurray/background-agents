import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { evaluateTurnAuthor } from "../../src/harness/turn-authority";
import { cleanD1Tables } from "./cleanup";
import { initSession, seedActiveUser } from "./helpers";

/**
 * The turn's author must still be allowed to act.
 *
 * A harness with no sandbox has no containment, so the check that stops a
 * suspended user from finishing a turn has to be made again, at the moment
 * of the action, from the database as it stands now. These are the three
 * ways that check can fail, and each one must deny.
 */
describe("the turn author's current authority", () => {
  const AUTHOR = "turn-author-authority-author";
  const ACTION = "collaborate" as const;

  beforeEach(async () => {
    await cleanD1Tables();
    await seedActiveUser(AUTHOR);
  });

  it("allows an author who may still collaborate", async () => {
    const session = await initSession({ title: "authority" });

    const decision = await evaluateTurnAuthor(
      { db: env.DB, action: ACTION },
      {
        sessionId: session.sessionName,
        userId: AUTHOR,
        sessionRow: {
          id: session.sessionName,
          ownerUserId: AUTHOR,
          ownerTeamId: null,
          visibility: "private",
        },
      }
    );

    expect(decision).toEqual({ kind: "allowed" });
  });

  it("denies an author who has been suspended", async () => {
    const session = await initSession({ title: "suspended" });
    await env.DB.prepare("UPDATE users SET suspended_at = ? WHERE id = ?")
      .bind(Date.now(), AUTHOR)
      .run();

    const decision = await evaluateTurnAuthor(
      { db: env.DB, action: ACTION },
      {
        sessionId: session.sessionName,
        userId: AUTHOR,
        sessionRow: {
          id: session.sessionName,
          ownerUserId: AUTHOR,
          ownerTeamId: null,
          visibility: "private",
        },
      }
    );

    expect(decision.kind).toBe("denied");
  });

  it("denies an author who is not on the session", async () => {
    const session = await initSession({ title: "stranger" });

    const decision = await evaluateTurnAuthor(
      { db: env.DB, action: ACTION },
      {
        sessionId: session.sessionName,
        userId: AUTHOR,
        sessionRow: {
          id: session.sessionName,
          ownerUserId: "someone-else",
          ownerTeamId: null,
          visibility: "private",
        },
      }
    );

    expect(decision.kind).toBe("denied");
  });

  it("denies an author with no workspace role at all", async () => {
    const session = await initSession({ title: "roleless" });
    await env.DB.prepare("DELETE FROM user_role_assignments WHERE user_id = ?").bind(AUTHOR).run();

    const decision = await evaluateTurnAuthor(
      { db: env.DB, action: ACTION },
      {
        sessionId: session.sessionName,
        userId: AUTHOR,
        sessionRow: {
          id: session.sessionName,
          ownerUserId: AUTHOR,
          ownerTeamId: null,
          visibility: "private",
        },
      }
    );

    expect(decision.kind).toBe("denied");
  });
});

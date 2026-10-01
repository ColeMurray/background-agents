import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionCollaboratorStore } from "../../src/db/session-collaborators";
import { MAX_D1_QUERY_PARAMETERS } from "../../src/db/query-limits";
import { cleanD1Tables } from "./cleanup";

describe("SessionCollaboratorStore bulk lookups", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await env.DB.prepare(
      "INSERT INTO users (id, created_at, updated_at) VALUES ('owner', 1, 1), ('collaborator', 1, 1)"
    ).run();
    await env.DB.prepare(
      `INSERT INTO sessions (id, user_id, visibility, created_at, updated_at)
       VALUES ('private', 'owner', 'private', 1, 1), ('workspace', 'owner', 'workspace', 1, 1)`
    ).run();
    const store = new SessionCollaboratorStore(env.DB);
    await store.add("private", "collaborator", "owner");
    await store.add("workspace", "collaborator", "owner");
  });

  afterEach(() => vi.restoreAllMocks());

  it("returns collaborators for every requested session by default", async () => {
    expect(
      await new SessionCollaboratorStore(env.DB).listForSessions(["private", "workspace"])
    ).toEqual(
      new Map([
        ["private", ["collaborator"]],
        ["workspace", ["collaborator"]],
      ])
    );
  });

  it("filters by persisted visibility when privateOnly is enabled", async () => {
    const store = new SessionCollaboratorStore(env.DB);
    expect(await store.listForSessions(["private", "workspace"], { privateOnly: true })).toEqual(
      new Map([["private", ["collaborator"]]])
    );
    await env.DB.prepare("UPDATE sessions SET visibility = 'workspace' WHERE id = 'private'").run();
    expect(await store.listForSessions(["private", "workspace"], { privateOnly: true })).toEqual(
      new Map()
    );
    expect(await store.listUserIds("private")).toEqual(["collaborator"]);
  });

  it("preserves private-only filtering across query-sized batches", async () => {
    const ids = [
      ...Array.from({ length: MAX_D1_QUERY_PARAMETERS }, (_, index) => `missing-${index}`),
      "private",
      "workspace",
    ];
    expect(
      await new SessionCollaboratorStore(env.DB).listForSessions(ids, { privateOnly: true })
    ).toEqual(new Map([["private", ["collaborator"]]]));
  });

  it("does not query the database for an empty input", async () => {
    const prepare = vi.spyOn(env.DB, "prepare");
    expect(
      await new SessionCollaboratorStore(env.DB).listForSessions([], { privateOnly: true })
    ).toEqual(new Map());
    expect(prepare).not.toHaveBeenCalled();
  });
});

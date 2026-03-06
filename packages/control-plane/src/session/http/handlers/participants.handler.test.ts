import { describe, expect, it, vi } from "vitest";
import type { ParticipantRow } from "../../types";
import { createParticipantsHandler } from "./participants.handler";

function createParticipant(overrides: Partial<ParticipantRow> = {}): ParticipantRow {
  return {
    id: "participant-1",
    user_id: "user-1",
    scm_user_id: null,
    scm_login: "octocat",
    scm_email: "octocat@example.com",
    scm_name: "The Octocat",
    role: "member",
    scm_access_token_encrypted: "enc-access",
    scm_refresh_token_encrypted: "enc-refresh",
    scm_token_expires_at: 1234,
    ws_auth_token: null,
    ws_token_created_at: null,
    joined_at: 1,
    ...overrides,
  };
}

function createHandler() {
  const repository = {
    listParticipants: vi.fn(),
  };

  const handler = createParticipantsHandler({ repository });

  return {
    handler,
    repository,
  };
}

describe("createParticipantsHandler", () => {
  it("returns an empty list when there are no participants", async () => {
    const { handler, repository } = createHandler();
    repository.listParticipants.mockReturnValue([]);

    const response = handler.listParticipants();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ participants: [] });
  });

  it("maps repository participant rows to API response shape", async () => {
    const { handler, repository } = createHandler();
    repository.listParticipants.mockReturnValue([
      createParticipant(),
      createParticipant({
        id: "participant-2",
        user_id: "user-2",
        scm_login: "hubot",
        scm_name: "Hubot",
        role: "owner",
        joined_at: 2,
      }),
    ]);

    const response = handler.listParticipants();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      participants: [
        {
          id: "participant-1",
          userId: "user-1",
          scmLogin: "octocat",
          scmName: "The Octocat",
          role: "member",
          joinedAt: 1,
        },
        {
          id: "participant-2",
          userId: "user-2",
          scmLogin: "hubot",
          scmName: "Hubot",
          role: "owner",
          joinedAt: 2,
        },
      ],
    });
  });
});

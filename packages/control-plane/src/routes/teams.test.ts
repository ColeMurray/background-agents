import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  sessionVisibilitySchema,
  teamSessionsResponseSchema,
} from "@open-inspect/shared/types/teams";
import {
  SESSION_INBOX_CATEGORIES,
  sessionInboxSessionSchema,
} from "@open-inspect/shared/types/session-inbox";
import { sessionCapabilitiesSchema } from "@open-inspect/shared/types/sessions";

describe("team session response contract", () => {
  it("matches the inbox session projection with required scope and capabilities", () => {
    const row =
      teamSessionsResponseSchema.options[0].options[0].shape.items.element.shape.rootSession;
    expect(z.toJSONSchema(row)).toEqual(
      z.toJSONSchema(
        sessionInboxSessionSchema.extend({
          ownerTeamId: z.string().nullable(),
          visibility: sessionVisibilitySchema,
          capabilities: sessionCapabilitiesSchema,
        })
      )
    );
  });

  it("uses exactly the existing inbox categories", () => {
    expect(teamSessionsResponseSchema.options[1].shape.categories.keyType.options).toEqual(
      SESSION_INBOX_CATEGORIES
    );
  });
});

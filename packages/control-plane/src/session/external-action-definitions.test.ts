import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ExternalAction } from "@open-inspect/shared";
import { ExternalActionDefinitionRegistry } from "./external-action-definitions";

const action = { provider: "fake", action: "publish_comment" } as ExternalAction;

describe("ExternalActionDefinitionRegistry", () => {
  it("validates provider requests and public results with action-specific schemas", async () => {
    const registry = new ExternalActionDefinitionRegistry();
    registry.register({
      provider: "fake",
      action: "publish_comment",
      requestSchema: z.object({
        target: z.object({ issue: z.number().int().positive() }),
        arguments: z.object({ body: z.string().min(1) }),
      }),
      publicResultSchema: z.object({ publicationId: z.string() }) as never,
      executor: {
        execute: vi.fn(async () => ({
          kind: "succeeded" as const,
          publicResult: { accessToken: "must-not-become-public" },
        })),
        status: vi.fn(async () => ({ kind: "unknown" as const })),
      },
    });

    const definition = registry.get("fake", "publish_comment")!;
    expect(
      definition.requestSchema.safeParse({ target: { issue: 42 }, arguments: { body: "Hi" } })
        .success
    ).toBe(true);
    expect(
      definition.requestSchema.safeParse({ target: { issue: "42" }, arguments: { body: "" } })
        .success
    ).toBe(false);
    await expect(registry.validatingExecutor(definition).execute(action)).rejects.toThrow();
  });
});

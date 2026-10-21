import { beforeEach, describe, expect, it, vi } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import type { PiSessionDO } from "../../src/cloudflare/pi-durable-object";
import { initSession, queryDO } from "./helpers";
import { cleanD1Tables } from "./cleanup";
import { SessionInternalPaths } from "../../src/session/contracts";

/**
 * The export must be able to see the session.
 *
 * A Pi session keeps its own durable record in its own Durable Object, and the
 * export says plainly that the record itself is not in the export. What the
 * export *does* carry is the session's projection of it: the messages and the
 * events the session recorded while the turn ran.
 *
 * So the question this test answers is the one that matters: **does every
 * user-visible step of a Pi turn reach the session's own events?** If a step
 * stayed inside the Pi Durable Object, the export would look complete and
 * omit it — the failure the reference model calls a transcript export cannot
 * see.
 */
describe("the Pi projection the export reads", () => {
  beforeEach(cleanD1Tables);

  it("puts a Pi turn's tool call and its completion in the session's events", async () => {
    const session = await initSession({
      title: "pi-projection",
      harness: "pi",
      model: "openai/gpt-5.6-sol",
      repoOwner: null,
      repoName: null,
      repoId: null,
    });
    const sessionStub = env.SESSION.getByName(session.sessionName);
    const piStub = env.PI_SESSION ? env.PI_SESSION.getByName(session.sessionName) : undefined;
    if (!piStub) throw new Error("PI_SESSION test binding is missing");

    // The Pi runtime answers with one tool call and one answer.
    await runInDurableObject(piStub as unknown as DurableObjectStub, async (instance) => {
      const pi = instance as unknown as PiSessionDO;
      const faux = fauxProvider();
      (pi as unknown as { models: MutableModels }).models.setProvider(faux.provider);
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("write", { path: "notes.txt", content: "hello" }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("the notes are written"),
      ]);
      const root = await (await pi.harness.pi()).root(BACKGROUND_CONTEXT);
      await root.configure({ model: { provider: "faux", modelId: "faux-1" } }, BACKGROUND_CONTEXT);
    });

    // The session runs the turn.
    const response = await sessionStub.fetch(
      new Request(`http://session${SessionInternalPaths.piControl}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actorId: "user-1",
          source: "web",
          control: {
            sessionId: session.sessionName,
            requestId: "projection-1",
            action: "send",
            content: "write the notes",
          },
        }),
      })
    );
    expect(response.status).toBe(202);
    await vi.waitFor(async () => {
      await expect(
        queryDO(
          sessionStub,
          "SELECT state FROM pi_control_receipts WHERE request_id = ?",
          "projection-1"
        )
      ).resolves.toEqual([{ state: "completed" }]);
    });

    // The session's own events: the tool call and the terminal completion.
    // These are exactly the rows the export reads.
    const events = await queryDO<{ type: string }>(
      sessionStub,
      "SELECT type FROM events WHERE message_id = ? ORDER BY timeline_sequence",
      "pi-control:projection-1"
    );
    const types = events.map((event) => event.type);
    expect(types).toContain("tool_call");
    expect(types).toContain("execution_complete");
  });
});

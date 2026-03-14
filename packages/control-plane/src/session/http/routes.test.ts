import { describe, expect, it } from "vitest";
import { SessionInternalPaths } from "../contracts";
import { createSessionInternalRoutes, type SessionInternalRouteHandler } from "./routes";

function noopHandler(): SessionInternalRouteHandler {
  return () => new Response("ok");
}

describe("createSessionInternalRoutes", () => {
  it("builds the expected method/path mapping", () => {
    const routes = createSessionInternalRoutes({
      init: noopHandler(),
      state: noopHandler(),
      prompt: noopHandler(),
      stop: noopHandler(),
      sandboxEvent: noopHandler(),
      listParticipants: noopHandler(),
      addParticipant: noopHandler(),
      listEvents: noopHandler(),
      listArtifacts: noopHandler(),
      listMessages: noopHandler(),
      createPr: noopHandler(),
      wsToken: noopHandler(),
      updateTitle: noopHandler(),
      archive: noopHandler(),
      unarchive: noopHandler(),
      verifySandboxToken: noopHandler(),
      openaiTokenRefresh: noopHandler(),
      spawnContext: noopHandler(),
      childSummary: noopHandler(),
      cancel: noopHandler(),
      childSessionUpdate: noopHandler(),
    });

    const methodPathSet = new Set(routes.map((route) => `${route.method} ${route.path}`));

    expect(methodPathSet).toEqual(
      new Set([
        `POST ${SessionInternalPaths.init}`,
        `GET ${SessionInternalPaths.state}`,
        `POST ${SessionInternalPaths.prompt}`,
        `POST ${SessionInternalPaths.stop}`,
        `POST ${SessionInternalPaths.sandboxEvent}`,
        `GET ${SessionInternalPaths.participants}`,
        `POST ${SessionInternalPaths.participants}`,
        `GET ${SessionInternalPaths.events}`,
        `GET ${SessionInternalPaths.artifacts}`,
        `GET ${SessionInternalPaths.messages}`,
        `POST ${SessionInternalPaths.createPr}`,
        `POST ${SessionInternalPaths.wsToken}`,
        `POST ${SessionInternalPaths.updateTitle}`,
        `POST ${SessionInternalPaths.archive}`,
        `POST ${SessionInternalPaths.unarchive}`,
        `POST ${SessionInternalPaths.verifySandboxToken}`,
        `POST ${SessionInternalPaths.openaiTokenRefresh}`,
        `GET ${SessionInternalPaths.spawnContext}`,
        `GET ${SessionInternalPaths.childSummary}`,
        `POST ${SessionInternalPaths.cancel}`,
        `POST ${SessionInternalPaths.childSessionUpdate}`,
      ])
    );
  });
});

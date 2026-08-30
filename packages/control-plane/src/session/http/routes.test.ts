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
      snapshot: noopHandler(),
      sandboxAccess: noopHandler(),
      prompt: noopHandler(),
      autofix: noopHandler(),
      stop: noopHandler(),
      sandboxEvent: noopHandler(),
      sandboxError: noopHandler(),
      createMediaArtifact: noopHandler(),
      recordAttachment: noopHandler(),
      listParticipants: noopHandler(),
      listEvents: noopHandler(),
      listArtifacts: noopHandler(),
      listMessages: noopHandler(),
      createPr: noopHandler(),
      pullRequestArtifactSnapshot: noopHandler(),
      pullRequestsRefresh: noopHandler(),
      wsToken: noopHandler(),
      updateTitle: noopHandler(),
      archive: noopHandler(),
      unarchive: noopHandler(),
      expireDraft: noopHandler(),
      verifySandboxToken: noopHandler(),
      openaiTokenRefresh: noopHandler(),
      xaiTokenRefresh: noopHandler(),
      scmCredentials: noopHandler(),
      tunnelUrls: noopHandler(),
      spawnContext: noopHandler(),
      activePromptAuthor: noopHandler(),
      childSummary: noopHandler(),
      parentPrompt: noopHandler(),
      cancel: noopHandler(),
      childSessionUpdate: noopHandler(),
      diffState: noopHandler(),
      diffStore: noopHandler(),
      diffFailure: noopHandler(),
      diffResolveFile: noopHandler(),
      diffRetry: noopHandler(),
    });

    const methodPathSet = new Set(routes.map((route) => `${route.method} ${route.path}`));

    expect(methodPathSet).toEqual(
      new Set([
        `POST ${SessionInternalPaths.init}`,
        `GET ${SessionInternalPaths.snapshot}`,
        `GET ${SessionInternalPaths.sandboxAccess}`,
        `GET ${SessionInternalPaths.state}`,
        `POST ${SessionInternalPaths.prompt}`,
        `POST ${SessionInternalPaths.autofix}`,
        `POST ${SessionInternalPaths.stop}`,
        `POST ${SessionInternalPaths.sandboxEvent}`,
        `POST ${SessionInternalPaths.sandboxError}`,
        `POST ${SessionInternalPaths.createMediaArtifact}`,
        `POST ${SessionInternalPaths.attachments}`,
        `GET ${SessionInternalPaths.participants}`,
        `GET ${SessionInternalPaths.events}`,
        `GET ${SessionInternalPaths.artifacts}`,
        `GET ${SessionInternalPaths.messages}`,
        `POST ${SessionInternalPaths.createPr}`,
        `POST ${SessionInternalPaths.pullRequestArtifactSnapshot}`,
        `POST ${SessionInternalPaths.pullRequestsRefresh}`,
        `POST ${SessionInternalPaths.wsToken}`,
        `POST ${SessionInternalPaths.updateTitle}`,
        `POST ${SessionInternalPaths.archive}`,
        `POST ${SessionInternalPaths.unarchive}`,
        `POST ${SessionInternalPaths.expireDraft}`,
        `POST ${SessionInternalPaths.verifySandboxToken}`,
        `POST ${SessionInternalPaths.openaiTokenRefresh}`,
        `POST ${SessionInternalPaths.xaiTokenRefresh}`,
        `POST ${SessionInternalPaths.scmCredentials}`,
        `GET ${SessionInternalPaths.tunnelUrls}`,
        `GET ${SessionInternalPaths.spawnContext}`,
        `GET ${SessionInternalPaths.activePromptAuthor}`,
        `GET ${SessionInternalPaths.childSummary}`,
        `POST ${SessionInternalPaths.parentPrompt}`,
        `POST ${SessionInternalPaths.cancel}`,
        `POST ${SessionInternalPaths.childSessionUpdate}`,
        `GET ${SessionInternalPaths.diffState}`,
        `POST ${SessionInternalPaths.diffStore}`,
        `POST ${SessionInternalPaths.diffFailure}`,
        `GET ${SessionInternalPaths.diffResolveFile}`,
        `POST ${SessionInternalPaths.diffRetry}`,
      ])
    );
  });
});

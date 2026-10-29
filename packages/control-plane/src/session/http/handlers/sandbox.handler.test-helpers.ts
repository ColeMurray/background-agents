import { vi } from "vitest";
import type { Logger } from "../../../logger";
import type { SandboxRow, SessionRow } from "../../types";
import { SandboxHandler } from "./sandbox.handler";
import type { ArtifactRepository } from "../../artifact-repository";
import type { EventRepository } from "../../event-repository";
import type { MessageRepository } from "../../message-repository";
import type { SessionCoreRepository } from "../../session-core-repository";
import type { SessionSandboxEventProcessor } from "../../sandbox-events/processor";

export function createHandler() {
  const repository = {
    createEvent: vi.fn(),
    getProcessingMessage: vi.fn(),
  };
  const artifactRepository = { createArtifact: vi.fn() } as unknown as ArtifactRepository;
  const processSandboxEvent = vi.fn();
  const getSandbox = vi.fn<() => SandboxRow | null>();
  const isValidSandboxToken = vi.fn();
  const getSession = vi.fn<() => SessionRow | null>();
  const refreshOpenAIToken = vi.fn();
  const refreshXaiToken = vi.fn();
  const getScmCredentials = vi.fn();
  const broadcast = vi.fn();
  const failSandbox = vi.fn(async (_reason: string) => {});
  const messenger = { broadcast, sendToSandbox: vi.fn(async () => {}) };
  const generateId = vi.fn(() => "participant-1");
  const now = vi.fn(() => 1234);

  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;

  const sandboxHandler = new SandboxHandler(
    repository as unknown as MessageRepository,
    repository as unknown as EventRepository,
    artifactRepository,
    { getSession } as unknown as SessionCoreRepository,
    { getSandbox },
    { processSandboxEvent } as unknown as SessionSandboxEventProcessor,
    messenger,
    refreshOpenAIToken,
    refreshXaiToken,
    getScmCredentials,
    isValidSandboxToken,
    failSandbox,
    generateId,
    now
  );

  // Bind the request-scoped log so call sites exercise the threading without
  // repeating it at every invocation.
  const handler = {
    sandboxEvent: (request: Request) => sandboxHandler.sandboxEvent(request),
    sandboxError: (request: Request) => sandboxHandler.sandboxError(request, log),
    createMediaArtifact: (request: Request) => sandboxHandler.createMediaArtifact(request),
    verifySandboxToken: (request: Request) => sandboxHandler.verifySandboxToken(request, log),
    openaiTokenRefresh: () => sandboxHandler.openaiTokenRefresh(log),
    xaiTokenRefresh: () => sandboxHandler.xaiTokenRefresh(log),
    scmCredentials: () => sandboxHandler.scmCredentials(log),
    tunnelUrls: () => sandboxHandler.tunnelUrls(log),
  };

  return {
    handler,
    repository,
    artifactRepository,
    processSandboxEvent,
    getSandbox,
    isValidSandboxToken,
    getSession,
    refreshOpenAIToken,
    refreshXaiToken,
    getScmCredentials,
    broadcast,
    failSandbox,
    generateId,
    now,
    log,
  };
}

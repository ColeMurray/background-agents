import type { z } from "zod";
import { expectTypeOf, it } from "vitest";
import type {
  Automation,
  AutomationRepository,
  AutomationRepositoryInput,
  CreateAutomationRequest,
  CreateEnvironmentInput,
  CreateSessionInput,
  CreateSessionRequest,
  ListAutomationsResponse,
  RepositoryInput,
  SandboxEvent,
  ServerMessage,
  UpdateEnvironmentInput,
  createEnvironmentInputSchema,
  createSessionInputSchema,
  createSessionRequestSchema,
  repositoryInputSchema,
  sandboxEventSchema,
  serverMessageSchema,
  updateEnvironmentInputSchema,
} from ".";

it("preserves public Zod input and output relationships", () => {
  expectTypeOf<RepositoryInput>().toEqualTypeOf<z.input<typeof repositoryInputSchema>>();
  expectTypeOf<CreateEnvironmentInput>().toEqualTypeOf<
    z.input<typeof createEnvironmentInputSchema>
  >();
  expectTypeOf<UpdateEnvironmentInput>().toEqualTypeOf<
    z.input<typeof updateEnvironmentInputSchema>
  >();
  expectTypeOf<CreateSessionRequest>().toEqualTypeOf<z.output<typeof createSessionRequestSchema>>();
  expectTypeOf<CreateSessionInput>().toEqualTypeOf<z.output<typeof createSessionInputSchema>>();
  expectTypeOf<SandboxEvent>().toEqualTypeOf<z.output<typeof sandboxEventSchema>>();
  expectTypeOf<ServerMessage>().toEqualTypeOf<z.output<typeof serverMessageSchema>>();
  expectTypeOf<AutomationRepositoryInput>().toEqualTypeOf<RepositoryInput>();
});

it("preserves the repository transform boundary", () => {
  const input: RepositoryInput = {
    repoOwner: "Acme",
    repoName: "Web",
  };
  const output: z.output<typeof repositoryInputSchema> = {
    repoOwner: "acme",
    repoName: "web",
    baseBranch: null,
  };

  expectTypeOf(input.baseBranch).toEqualTypeOf<string | null | undefined>();
  expectTypeOf(output.baseBranch).toEqualTypeOf<string | null>();

  // @ts-expect-error Transformed output always contains the normalized baseBranch.
  const invalidOutput: z.output<typeof repositoryInputSchema> = {
    repoOwner: "acme",
    repoName: "web",
  };

  void invalidOutput;
});

it("preserves representative session and protocol contracts", () => {
  const wireInput: z.input<typeof createSessionRequestSchema> = {
    repositories: [{ repoOwner: "acme", repoName: "web" }],
  };
  const request: CreateSessionRequest = {
    repositories: [{ repoOwner: "acme", repoName: "web", baseBranch: null }],
  };
  const internalInput: CreateSessionInput = {
    repositories: [{ repoOwner: "acme", repoName: "web", baseBranch: null }],
    scmLogin: "ada",
  };
  const event = {
    type: "ready",
    sandboxId: "sandbox-1",
    opencodeSessionId: null,
    timestamp: 1,
  } satisfies SandboxEvent;
  const message = {
    type: "error",
    code: "BAD_REQUEST",
    message: "invalid",
  } satisfies ServerMessage;

  void [wireInput, request, internalInput, event, message];
});

it("preserves representative automation contracts", () => {
  const request = {
    name: "nightly",
    instructions: "inspect failures",
    repositories: [{ repoOwner: "acme", repoName: "web" }],
    environmentIds: ["env_1"],
  } satisfies CreateAutomationRequest;

  expectTypeOf<Automation["repositories"]>().toEqualTypeOf<AutomationRepository[]>();
  expectTypeOf<ListAutomationsResponse["automations"]>().toEqualTypeOf<Automation[]>();

  void request;
});

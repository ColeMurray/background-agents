import type { z } from "zod";
import { expectTypeOf, it } from "vitest";
import type {
  AutomationTriggerType,
  ConditionConfigMap,
  ConditionType,
  JsonPathFilter,
  TextMatchValue,
  TriggerCondition,
  TriggerConfig,
} from "..";
import type {
  Automation,
  AutomationRepositoryInput,
  CreateEnvironmentInput,
  RepositoryInput,
  ServerMessage,
  UpdateEnvironmentInput,
  createEnvironmentInputSchema,
  repositoryInputSchema,
  serverMessageSchema,
  updateEnvironmentInputSchema,
} from ".";
import type { SandboxEvent, sandboxEventSchema } from "./sandbox-events";
import type {
  CreateSessionInput,
  CreateSessionRequest,
  createSessionInputSchema,
  createSessionRequestSchema,
} from "./session-api";

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

it("preserves public trigger type shapes", () => {
  const condition = {
    type: "branch",
    operator: "glob_match",
    value: ["main"],
  } satisfies TriggerCondition;
  const config = { conditions: [condition] } satisfies TriggerConfig;

  expectTypeOf<ConditionType>().toEqualTypeOf<keyof ConditionConfigMap>();
  expectTypeOf<Extract<TriggerCondition, { type: "jsonpath" }>["value"]>().toEqualTypeOf<
    JsonPathFilter[]
  >();
  expectTypeOf<
    Extract<TriggerCondition, { type: "text_match" }>["value"]
  >().toEqualTypeOf<TextMatchValue>();
  expectTypeOf<Automation["triggerType"]>().toEqualTypeOf<AutomationTriggerType>();
  expectTypeOf<Automation["triggerConfig"]>().toEqualTypeOf<TriggerConfig | null>();

  void config;
});

import type { JsonValue } from "@earendil-works/chord";
import type { ExternalActionPrepareRequest } from "@open-inspect/shared";
import type { ZodType } from "zod";
import type {
  ExternalActionExecutionResult,
  ExternalActionExecutor,
  ExternalActionProviderStatus,
} from "./external-action-gateway";

export type CredentialFreeExternalActionRequest = Pick<
  ExternalActionPrepareRequest,
  "target" | "arguments"
>;

/** Provider/action contract; credentials stay closed over by its executor. */
export interface ExternalActionDefinition {
  provider: string;
  action: string;
  requestSchema: ZodType<CredentialFreeExternalActionRequest>;
  publicResultSchema: ZodType<JsonValue>;
  executor: ExternalActionExecutor;
}

export class ExternalActionDefinitionRegistry {
  private readonly definitions = new Map<string, ExternalActionDefinition>();

  register(definition: ExternalActionDefinition): void {
    const key = definitionKey(definition.provider, definition.action);
    if (this.definitions.has(key))
      throw new Error(`External action definition already exists: ${key}`);
    this.definitions.set(key, definition);
  }

  get(provider: string, action: string): ExternalActionDefinition | undefined {
    return this.definitions.get(definitionKey(provider, action));
  }

  validatingExecutor(definition: ExternalActionDefinition): ExternalActionExecutor {
    return {
      execute: async (action) =>
        validateExecutionResult(
          await definition.executor.execute(action),
          definition.publicResultSchema
        ),
      status: async (action) =>
        validateProviderStatus(
          await definition.executor.status(action),
          definition.publicResultSchema
        ),
    };
  }

  executorFor(provider: string, action: string): ExternalActionExecutor | undefined {
    const definition = this.get(provider, action);
    return definition ? this.validatingExecutor(definition) : undefined;
  }
}

function definitionKey(provider: string, action: string): string {
  return `${provider}\u0000${action}`;
}

function validateExecutionResult(
  result: ExternalActionExecutionResult,
  schema: ZodType<JsonValue>
): ExternalActionExecutionResult {
  return result.kind === "succeeded"
    ? { ...result, publicResult: schema.parse(result.publicResult) }
    : result;
}

function validateProviderStatus(
  result: ExternalActionProviderStatus,
  schema: ZodType<JsonValue>
): ExternalActionProviderStatus {
  return result.kind === "succeeded"
    ? { ...result, publicResult: schema.parse(result.publicResult) }
    : result;
}

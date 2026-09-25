/**
 * Validates every registered GraphQL document against Linear's published
 * schema (`linear-schema.graphql`, refreshed with `npm run
 * update:linear-schema`). Unit tests mock `fetch`, so without this check a
 * misspelled type or field only surfaces as an HTTP 400 in production.
 */

/// <reference types="vite/client" />
import {
  buildSchema,
  getVariableValues,
  Kind,
  parse,
  validate,
  type GraphQLSchema,
  type OperationDefinitionNode,
} from "graphql";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import schemaSource from "../../linear-schema.graphql?raw";
import { getRepoSuggestions, type LinearApiClient } from "./linear-client";
import { LINEAR_DOCUMENTS } from "./linear-documents";

function validationErrors(schema: GraphQLSchema, source: string): string[] {
  return validate(schema, parse(source)).map((error) => error.message);
}

function operation(source: string): OperationDefinitionNode {
  const operations = parse(source).definitions.filter(
    (definition): definition is OperationDefinitionNode =>
      definition.kind === Kind.OPERATION_DEFINITION
  );
  expect(operations).toHaveLength(1);
  return operations[0];
}

let schema: GraphQLSchema;

beforeAll(() => {
  schema = buildSchema(schemaSource);
});

describe("LINEAR_DOCUMENTS", () => {
  it.each(Object.entries(LINEAR_DOCUMENTS))(
    "%s validates against Linear's schema",
    (name, source) => {
      expect(operation(source).name?.value).toBe(name);
      expect(validationErrors(schema, source)).toEqual([]);
    }
  );

  it("rejects an unknown variable type", () => {
    expect(
      validationErrors(
        schema,
        `query Q($candidateRepositories: [IssueRepositorySuggestionInput!]!) {
          issueRepositorySuggestions(issueId: "i", candidateRepositories: $candidateRepositories) {
            suggestions { repositoryFullName }
          }
        }`
      )
    ).toContainEqual(expect.stringContaining('Unknown type "IssueRepositorySuggestionInput"'));
  });
});

describe("getRepoSuggestions request", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends variables that coerce to the schema's input types", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ data: { issueRepositorySuggestions: { suggestions: [] } } })
    );
    vi.stubGlobal("fetch", fetchMock);
    const client: LinearApiClient = {
      accessToken: "test-token",
      organizationId: "org-1",
      renewAccessToken: async () => "renewed-token",
    };

    await getRepoSuggestions(client, "issue-1", "agent-1", [
      { hostname: "github.com", repositoryFullName: "acme/api" },
    ]);

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    expect(body.query).toBe(LINEAR_DOCUMENTS.RepoSuggestions);
    const coerced = getVariableValues(
      schema,
      operation(body.query).variableDefinitions ?? [],
      body.variables
    );
    expect(coerced.errors?.map((error) => error.message)).toBeUndefined();
  });
});

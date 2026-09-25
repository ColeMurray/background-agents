/**
 * Validates the GraphQL documents the bot sends against Linear's published
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

/** Every non-test source file in the package, keyed by root-relative path. */
const SOURCE_FILES = import.meta.glob<string>(["/src/**/*.ts", "!/src/**/*.test.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
});

/** Template literals whose content starts with an operation keyword. */
const GRAPHQL_DOCUMENT_PATTERN = /`\s*((?:query|mutation|subscription)\b[^`]*)`/g;

interface SourceDocument {
  file: string;
  source: string;
}

function findSourceDocuments(): SourceDocument[] {
  return Object.entries(SOURCE_FILES).flatMap(([file, contents]) =>
    [...contents.matchAll(GRAPHQL_DOCUMENT_PATTERN)].map((match) => ({ file, source: match[1] }))
  );
}

function validationErrors(schema: GraphQLSchema, source: string): string[] {
  return validate(schema, parse(source)).map((error) => error.message);
}

function operationName(source: string): string | undefined {
  const operation = parse(source).definitions.find(
    (definition): definition is OperationDefinitionNode =>
      definition.kind === Kind.OPERATION_DEFINITION
  );
  return operation?.name?.value;
}

let schema: GraphQLSchema;

beforeAll(() => {
  schema = buildSchema(schemaSource);
});

describe("Linear GraphQL documents", () => {
  const documents = findSourceDocuments();

  it("finds the documents the bot sends", () => {
    expect(documents.map((document) => operationName(document.source))).toEqual(
      expect.arrayContaining(["RepoSuggestions", "AgentActivityCreate", "LinearViewerIdentity"])
    );
  });

  it.each(documents.map((document) => [operationName(document.source), document] as const))(
    "%s validates against Linear's schema",
    (_name, document) => {
      expect(validationErrors(schema, document.source), document.file).toEqual([]);
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
      { hostname: "gitlab.com", repositoryFullName: "group/subgroup/api" },
    ]);

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    const operation = parse(body.query).definitions[0] as OperationDefinitionNode;
    const coerced = getVariableValues(schema, operation.variableDefinitions ?? [], body.variables);
    expect(validationErrors(schema, body.query)).toEqual([]);
    expect(coerced.errors?.map((error) => error.message)).toBeUndefined();
  });
});

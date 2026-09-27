/**
 * Every GraphQL document the bot sends to Linear. `linearGraphQL` accepts
 * only a {@link LinearDocument}, and this module is the only place one is
 * constructed, so `linear-documents.test.ts` validating this registry against
 * Linear's schema covers everything the bot can send.
 */

declare const linearDocumentBrand: unique symbol;

/** A GraphQL document registered in {@link LINEAR_DOCUMENTS}. */
export type LinearDocument = string & { readonly [linearDocumentBrand]: true };

function document(source: string): LinearDocument {
  return source as LinearDocument;
}

/** Keyed by operation name; the test checks each key matches its operation. */
export const LINEAR_DOCUMENTS = {
  AgentActivityCreate: document(`
    mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
      agentActivityCreate(input: $input) {
        success
      }
    }
  `),
  IssueDetails: document(`
    query IssueDetails($id: String!) {
      issue(id: $id) {
        id
        identifier
        title
        description
        url
        priority
        priorityLabel
        labels { nodes { id name } }
        project { id name }
        assignee { id name }
        team { id key name }
        comments(first: 10, orderBy: createdAt) {
          nodes {
            body
            user { name }
          }
        }
      }
    }
  `),
  AgentSessionUpdate: document(`
    mutation AgentSessionUpdate($id: String!, $input: AgentSessionUpdateInput!) {
      agentSessionUpdate(id: $id, input: $input) {
        success
      }
    }
  `),
  RepoSuggestions: document(`
    query RepoSuggestions(
      $issueId: String!
      $agentSessionId: String!
      $candidateRepositories: [CandidateRepository!]!
    ) {
      issueRepositorySuggestions(
        issueId: $issueId
        agentSessionId: $agentSessionId
        candidateRepositories: $candidateRepositories
      ) {
        suggestions {
          repositoryFullName
          confidence
        }
      }
    }
  `),
  FetchUser: document(`
    query FetchUser($id: String!) {
      user(id: $id) {
        id
        name
        email
      }
    }
  `),
  CommentCreate: document(`
    mutation CommentCreate($input: CommentCreateInput!) {
      commentCreate(input: $input) { success }
    }
  `),
  IssueStartTransitionContext: document(`
    query IssueStartTransitionContext($issueId: String!) {
      issue(id: $issueId) {
        state { type }
        team {
          states(filter: { type: { eq: "started" } }) {
            nodes { id name position }
          }
        }
      }
    }
  `),
  IssueMoveToStarted: document(`
    mutation IssueMoveToStarted($issueId: String!, $stateId: String!) {
      issueUpdate(id: $issueId, input: { stateId: $stateId }) {
        success
      }
    }
  `),
  LinearViewerIdentity: document(`
    query LinearViewerIdentity { viewer { id organization { id name } } }
  `),
};

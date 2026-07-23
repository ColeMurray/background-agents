import { z } from "zod";
import { linearGraphQL, type LinearApiClient } from "./linear-client";

type LinearGraphQLExecutor = typeof linearGraphQL;

const workflowStateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  position: z.number().refine(Number.isFinite),
});

const transitionContextSchema = z.object({
  data: z.object({
    issue: z
      .object({
        state: z.object({
          type: z.string().min(1),
        }),
        team: z.object({
          states: z.object({ nodes: z.array(workflowStateSchema) }),
        }),
      })
      .nullable(),
  }),
});

const transitionMutationSchema = z.object({
  data: z.object({
    issueUpdate: z.object({ success: z.literal(true) }),
  }),
});

export type IssueStartTransitionResult =
  | {
      outcome: "transitioned";
      previousStateType: string;
      stateId: string;
      stateName: string;
    }
  | {
      outcome: "already_started" | "terminal_completed" | "terminal_canceled" | "no_started_state";
      previousStateType: string;
    }
  | { outcome: "issue_not_found" };

/** Move an issue forward to the team's first started workflow state. */
export async function transitionIssueToStarted(
  client: LinearApiClient,
  issueId: string,
  execute: LinearGraphQLExecutor = linearGraphQL
): Promise<IssueStartTransitionResult> {
  const contextResponse = transitionContextSchema.parse(
    await execute(
      client,
      `
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
    `,
      { issueId }
    )
  );

  const issue = contextResponse.data.issue;
  if (!issue) return { outcome: "issue_not_found" };

  const previousStateType = issue.state.type.toLowerCase();
  if (previousStateType === "started") {
    return { outcome: "already_started", previousStateType };
  }
  if (previousStateType === "completed") {
    return { outcome: "terminal_completed", previousStateType };
  }
  if (previousStateType === "canceled") {
    return { outcome: "terminal_canceled", previousStateType };
  }

  const target = [...issue.team.states.nodes].sort(
    (a, b) => a.position - b.position || a.id.localeCompare(b.id)
  )[0];
  if (!target) return { outcome: "no_started_state", previousStateType };

  transitionMutationSchema.parse(
    await execute(
      client,
      `
      mutation IssueMoveToStarted($issueId: String!, $stateId: String!) {
        issueUpdate(id: $issueId, input: { stateId: $stateId }) {
          success
        }
      }
    `,
      { issueId, stateId: target.id }
    )
  );

  return {
    outcome: "transitioned",
    previousStateType,
    stateId: target.id,
    stateName: target.name,
  };
}

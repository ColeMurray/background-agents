/**
 * Agent plan step types and factory used by both the webhook handler and callbacks.
 */

export type PlanStepStatus = "pending" | "inProgress" | "completed" | "canceled";

export interface PlanStep {
  content: string;
  status: PlanStepStatus;
}

export type PlanStage =
  | "start"
  | "repo_resolved"
  | "session_created"
  | "plan_awaiting_approval"
  | "completed"
  | "failed";

export function makePlan(stage: PlanStage): PlanStep[] {
  const steps = [
    "Analyze issue",
    "Resolve repository",
    "Create coding session",
    "Code changes",
    "Open PR",
  ];
  const statusMap: Record<PlanStage, PlanStepStatus[]> = {
    start: ["inProgress", "inProgress", "pending", "pending", "pending"],
    repo_resolved: ["completed", "completed", "inProgress", "pending", "pending"],
    session_created: ["completed", "completed", "completed", "inProgress", "pending"],
    // HITL: the agent produced a plan and is waiting for human approval.
    // We leave "Code changes" pending — it won't start until /plan/approve.
    plan_awaiting_approval: ["completed", "completed", "completed", "pending", "pending"],
    completed: ["completed", "completed", "completed", "completed", "completed"],
    failed: ["completed", "completed", "completed", "completed", "canceled"],
  };
  const statuses = statusMap[stage];
  return steps.map((content, i) => ({ content, status: statuses[i] }));
}

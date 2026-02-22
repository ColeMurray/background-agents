import { describe, expect, it } from "vitest";
import { makePlan } from "./plan";

const EXPECTED_CONTENT = [
  "Analyze issue",
  "Resolve repository",
  "Create coding session",
  "Code changes",
  "Open PR",
];

describe("makePlan", () => {
  it("returns 5 steps with correct content labels", () => {
    const steps = makePlan("start");
    expect(steps).toHaveLength(5);
    expect(steps.map((s) => s.content)).toEqual(EXPECTED_CONTENT);
  });

  it("start → [inProgress, inProgress, pending, pending, pending]", () => {
    const statuses = makePlan("start").map((s) => s.status);
    expect(statuses).toEqual(["inProgress", "inProgress", "pending", "pending", "pending"]);
  });

  it("repo_resolved → [completed, completed, inProgress, pending, pending]", () => {
    const statuses = makePlan("repo_resolved").map((s) => s.status);
    expect(statuses).toEqual(["completed", "completed", "inProgress", "pending", "pending"]);
  });

  it("session_created → [completed, completed, completed, inProgress, pending]", () => {
    const statuses = makePlan("session_created").map((s) => s.status);
    expect(statuses).toEqual(["completed", "completed", "completed", "inProgress", "pending"]);
  });

  it("completed → all completed", () => {
    const statuses = makePlan("completed").map((s) => s.status);
    expect(statuses).toEqual(["completed", "completed", "completed", "completed", "completed"]);
  });

  it("failed → first 4 completed, last canceled", () => {
    const statuses = makePlan("failed").map((s) => s.status);
    expect(statuses).toEqual(["completed", "completed", "completed", "completed", "canceled"]);
  });
});

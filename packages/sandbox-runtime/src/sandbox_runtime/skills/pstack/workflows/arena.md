# Arena

Use when one attempt at a non-trivial design or implementation would lock in the wrong shape.
Produce several independent candidates, judge them against one rubric, select a base, graft only the
strongest ideas, and verify the synthesis.

## Phases

1. Frame
2. Fan out
3. Cross-judge
4. Pick
5. Graft
6. Verify

## Frame

Write one candidate brief. Every candidate gets the same contract.

1. Name the artifact.
2. Derive three to six gradeable criteria from the actual task.
3. Pick the smallest candidate count that explores distinct shapes. Default to three.
4. Decide whether candidates are read-only designs or code-producing branches.

Do not show candidates the scoring rubric. It belongs to the parent and judge.

## Fan out

Spawn all candidates as OpenInspect child sessions in one turn. Give each the same task and
grounding. Ask each for an explicit rationale naming alternatives considered and rejected.

For design work, forbid repository writes and require the complete design in the final response.

For code work, each child owns its isolated sandbox and must create a separate draft pull request.
The final response must include the pull request URL, head commit, verification run, and rationale.
Sibling sandboxes cannot exchange local paths.

Wait for the candidate IDs with `wait-for-children`. Record failures as dropouts.

## Cross-judge

After candidates finish, spawn one new read-only child as the blinded judge. Give it:

- the rubric;
- candidate outputs under neutral labels;
- pull request URLs for code candidates;
- instructions to score each criterion and recommend a base.

Do not identify candidate models. Prefer a different enabled model when availability is known;
otherwise inherit the parent model. Wait for the judge with `wait-for-children`.

## Pick

Read every candidate and the judge report. Score criterion by criterion. Agreement confirms the
pick. Disagreement means the rubric or one reviewer may be biased; resolve it from evidence.

Prefer the candidate a future maintainer can extend without learning hidden rules. When tied, choose
the smaller public API and clearer ownership boundary.

## Graft

Usually one or two ideas from each losing candidate are worth keeping. Do not average incompatible
designs.

For code candidates, use `send-child-prompt` on the selected base child with the judge report,
competing pull request URLs, and the exact graft list. The child fetches the competing branches,
integrates the chosen ideas coherently, updates its own pull request, and verifies again. Then call
`wait-for-children` for that child ID.

For prose or design candidates, the parent writes the synthesis.

If candidates converge, keep the consensus shape without ceremonial grafting. If they diverge
because the contract was underspecified, reframe and rerun instead of blending them.

## Verify

Exercise the synthesized artifact against the original acceptance criteria. A judge verdict is not
verification. Return the final artifact plus a short synthesis note naming the base, grafts,
rejections, dropouts, and observed verification.

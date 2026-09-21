# Swarm

Use when the user asks to swarm a task, cover many independent slices, race several attempts, or run
work in parallel child sandboxes.

## Phases

1. Frame
2. Fan out
3. Wait
4. Aggregate
5. Report

## Frame

State the done predicate and the artifact the swarm must return. Choose one shape:

- **Coverage.** Each child owns a distinct slice. Every required slice needs a terminal result.
- **Race.** Every child receives the same brief. Declare `first pass`, `rank all`, or `best of`
  before spawning.
- **Mixed.** Partition the work, then race selected high-risk slices.

Use the worker count the user gave. Otherwise derive the smallest count that gives independent
coverage. More children without distinct work only multiply noise.

## Fan out

Use `spawn-child` for separate OpenInspect sandboxes. Issue independent spawn calls in the same
turn.

Every brief must include:

```text
GOAL        the observable outcome
SCOPE       files or subsystem owned by this child
CONTEXT     repository paths, target branch or PR, and facts it cannot infer
ACCEPTANCE  checkable criteria
VERIFY      exact runtime scenario or commands
FORBIDDEN   scope escapes and mutable actions the child must not take
REPORT      PASS, ISSUES, or BLOCKED with evidence and artifact links
```

Children do not see the parent's uncommitted files. Inline a small diff when reviewing it. For
larger code targets, point to a pushed branch, commit, or pull request.

Read-only workers must receive
`FORBIDDEN: no edits, commits, pushes, pull requests, or mutable external actions`.

A writing child works only in its own sandbox. Require it to commit and create a pull request before
reporting so the parent can inspect its output. Never assign two children to write the same branch.

If `spawn-child` returns the configured concurrency limit, stop spawning. Wait for the current wave,
aggregate it, then launch the next pending slices. Do not retry the rejected call in a tight loop.

## Wait

Call `wait-for-children` once with the IDs from the current wave. Set a timeout appropriate to the
work. The tool returns terminal statuses and final responses. A timeout is a real gap, not
permission to claim completion.

Proceed with fewer workers after a failed child only when the declared coverage remains complete.
Otherwise replace that slice once or report it missing.

## Aggregate

For coverage, reconcile every slice against the done predicate. For a race, apply the declared
selection rule. Deduplicate repeated findings and distinguish consensus from copied assumptions.

Do not paste raw child output. Build a compact table with child, slice or arm, status, evidence, and
artifact.

## Report

Return one consolidated result containing the table, evidenced issues, selected race winner when
applicable, and all gaps or dropouts. Verify any code result through the parent or a dedicated
verifier before calling it complete.

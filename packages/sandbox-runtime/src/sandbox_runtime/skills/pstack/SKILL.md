---
name: pstack
description:
  "OpenInspect-native pstack workflows. Use for pstack, poteto mode, swarm, arena, interrogate,
  adversarial review, architecture exploration, blast-radius analysis, or parallel child-session
  work."
license: MIT
compatibility:
  "OpenInspect child-session tools; repository context required for isolated child sandboxes."
metadata:
  source: "https://github.com/cursor/plugins/tree/main/pstack"
  upstream-revision: "6ed0f7a9504f577d7529064103cecce9be7dfc5e"
---

# pstack for OpenInspect

Go deep before going fast. Understand the system, choose the smallest sound design, prove behavior
on the real surface, and use parallelism only when independent work exists.

This is an OpenInspect-native adaptation of
[pstack](https://github.com/cursor/plugins/tree/main/pstack). The upstream license is in
`LICENSE.pstack`.

## Route the request

Read the matching workflow before acting:

- Parallel coverage, independent slices, or races: `workflows/swarm.md`
- Several competing solutions followed by synthesis: `workflows/arena.md`
- Adversarial multi-reviewer code review: `workflows/interrogate.md`
- Codebase explanation or ownership question: `workflows/how.md`
- Non-trivial design before implementation: `workflows/architect.md`
- A cheap failing regression test is practical: `workflows/tdd.md`
- Determine what a change could break elsewhere: `workflows/blast-radius.md`
- Edit prose before presenting it: `workflows/unslop.md`

For ordinary work, use these built-in playbooks:

### Bug fix

1. Reproduce the reported failure on the same runtime surface. Do not ask the user to repeat
   evidence already supplied.
2. Trace callers and runtime state until one root cause explains the symptom. Read
   `principles/fix-root-causes.md`.
3. Add a focused failing regression check when `workflows/tdd.md` says it is worth keeping.
4. Make the smallest root-cause change and migrate every affected caller.
5. Repeat the original reproduction. Then run the narrow adjacent checks that could expose
   collateral damage.

### Feature

1. Trace the existing flow and ownership before choosing files.
2. State the observable outcome and acceptance checks.
3. Use `workflows/architect.md` only when the work crosses a meaningful boundary or has several
   credible shapes.
4. Implement the smallest complete version. Remove replaced paths instead of adding compatibility
   layers.
5. Exercise the feature through its real surface and retain only tests that protect a plausible
   regression.

### Investigation

1. State the question and what evidence would settle it.
2. Run the smallest experiment that distinguishes the leading explanations.
3. Report observed facts separately from inference.
4. Stop when the question is answered. Do not turn an investigation into an unrequested refactor.

## OpenInspect execution rules

Use the cheapest execution mode that preserves the required isolation:

1. Work directly when one agent can finish it coherently.
2. Use the harness's in-process Task or Agent delegation for read-only exploration that does not
   need a separate filesystem or model.
3. Use OpenInspect child sessions for isolated writers, model races, or independent sandboxes. The
   user must have explicitly invoked a pstack child workflow such as swarm, arena, interrogate, or
   architect, or otherwise asked for child sessions or isolated sandbox workers.

A child inherits the repository, harness, credentials, and this skill, but not the conversation or
the parent's uncommitted filesystem. Every child brief must stand alone and include the goal,
allowed scope, context, acceptance criteria, verification, forbidden actions, and report format.

Spawn independent children in one turn. Record every child ID. Call `wait-for-children` once with
those IDs when their results are needed. Do not hand-poll `get-child-status`.

For read-only work, enforce it in the brief: no edits, commits, pushes, pull requests, or mutable
external actions. For code-producing work, require a committed branch and pull request because
sibling sandboxes cannot read each other's files. A child that only returns prose must put the
complete artifact in its final response.

Children inherit the parent harness. Use explicit model IDs only when the user supplied them or
availability is already known. Otherwise inherit the parent model. If a requested model is
unavailable, fall back to the parent model and report the lost diversity instead of probing random
model names.

## Engineering principles

The adapted upstream principles live under `principles/`. Apply the relevant ones, not all of them
mechanically. The defaults are:

- Attack the premise after repeated fixes fail the same gate.
- Fix root causes, not symptoms.
- Subtract before adding.
- Separate writers before serializing shared state.
- Validate at boundaries and encode invariants in types.
- Sequence work into independently verifiable units.
- Test behavior, not implementation.
- Prove the changed behavior on the real surface.
- Minimize reader load and delete legacy paths after callers migrate.

## Completion

Own the synthesis. Do not paste child reports as the answer. Reconcile disagreements, verify the
selected result, name any missing coverage, and write the final response through
`workflows/unslop.md`.

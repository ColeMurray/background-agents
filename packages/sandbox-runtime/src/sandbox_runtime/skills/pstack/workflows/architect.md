# Architect

Use before implementation when a change crosses a meaningful boundary, changes ownership, introduces
shared state, or has several credible shapes. Do not invoke it for a local edit whose design is
already established.

## Ground

Run the pstack how workflow over every affected subsystem. Trace current ownership, public
contracts, state, and failure handling. Existing rationale is a constraint until evidence disproves
it.

## Sketch alternatives

State the caller's desired usage first. Then derive the types, signatures, data structures, module
ownership, state transitions, and verification seams.

For a one-way door or contested shape, run the pstack arena workflow with
`../references/architect/runner-prompt.md`. Require at least two structurally distinct candidates.
Screen them with `../references/architect/design-red-flags.md` and record the decision using
`../references/architect/rationale-template.md`.

Design sketches belong in the response or a requested design artifact. Do not leave `TODO`,
`not implemented`, or throwing stubs in production files.

## Choose

Prefer the design that:

- hides more complexity behind a smaller coherent interface;
- keeps transport and storage representations behind boundaries;
- gives each invariant one owner;
- separates independent writers;
- makes invalid states hard to represent;
- supports the dominant access patterns without speculative caches or indexes;
- matches existing repository conventions.

Default to proceeding when the decision is reversible. Stop for user input only when alternatives
encode materially different product behavior, irreversible migration risk, or cost the codebase
cannot answer.

## Implement

Treat the selected sketch as a hypothesis, not scripture. If implementation repeatedly needs the
same escape hatch, parameter, cast, lock, or special case, stop. Re-ground with the new evidence and
redesign instead of layering repairs onto the wrong shape.

Finish the complete behavior and verify it through the real surface. A design artifact without the
requested implementation is not completion.

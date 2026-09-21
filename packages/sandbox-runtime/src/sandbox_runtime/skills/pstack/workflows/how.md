# How

Use for code walkthroughs, subsystem architecture, ownership, placement, and layering questions.

## Assess complexity

- **Simple:** one module, utility, symbol, or narrow path. Explore and explain directly.
- **Complex:** a subsystem spanning several packages or runtime boundaries. Split it into two to
  four independent exploration angles.

When in doubt, take the simple path.

## Explore

For complex questions, use the harness's in-process Task or Agent delegation. Separate sandboxes add
no value to read-only source exploration. Give each explorer `../references/how/explorer-prompt.md`
with one distinct angle. Launch independent explorers together.

The parent traces the entry point and public contract while explorers work. When they finish,
synthesize from their evidence using `../references/how/explainer-prompt.md`.

Do not explain from filenames or type names alone. Follow actual calls, data transformations,
persistence, network boundaries, and error paths. Use symbol-aware navigation when available. Cite
exact paths and symbols.

## Explain

Use only sections that help:

- Overview
- Key concepts
- How it works
- Where things live
- Gotchas

State gaps explicitly. Keep source-level detail only when it changes the reader's mental model.

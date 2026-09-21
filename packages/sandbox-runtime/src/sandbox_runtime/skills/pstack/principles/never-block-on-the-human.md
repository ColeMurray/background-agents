# Never Block on the Human

The human supervises asynchronously. Agents must stay unblocked. Make reasonable decisions, proceed,
and let the human course-correct after the fact.

**Why:** Every permission pause stalls the pipeline and makes the human the bottleneck. Since code
changes are reversible and reviewable, a wrong decision usually costs less than blocking.

**Pattern:**

- **Proceed, then present.** Do the work, show the result. Don't ask "should I do X?" Do X, explain
  why.
- **Reserve questions for genuine ambiguity.** Ask only when you cannot infer intent from context.
- **Make the system self-healing.** When you notice a problem, log it and fix it in the next round.
- **Supervision is async.** Design workflows for review-after-the-fact.

**Boundaries:**

- **Irreversible actions** (force-push, delete production data, send external messages) still
  require confirmation.
- **Reversible actions** (write code, edit notes, split tasks) should proceed without blocking.
- **Product direction** comes from the human. _Execution_ should not block.

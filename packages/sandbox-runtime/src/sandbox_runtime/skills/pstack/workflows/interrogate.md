# Interrogate

Use for adversarial review, multi-reviewer review, stress testing code, or finding blind spots.
Independent reviewers challenge the same change. The parent makes the judgment and does not
auto-apply findings.

## Determine scope

Identify the exact files, diff, commit, branch, or pull request. Prefer a remotely reachable commit
or pull request. When the target is only an uncommitted local diff, include that diff in each child
brief because children cannot read the parent's filesystem.

State the author's intent in one paragraph. Derive it from the request, commit messages, pull
request description, and code. If evidence leaves a material product ambiguity, name it instead of
inventing intent.

## Spawn reviewers

Read these references:

- `../references/interrogate/reviewer-prompt.md`
- `../references/interrogate/rubric.md`
- `../references/interrogate/code-quality-review.md`
- `../references/interrogate/lead-judgment.md`

Spawn all reviewers as OpenInspect child sessions in one turn. Default to four reviewers unless the
user asks for another count. Use different enabled models only when their availability is known;
otherwise inherit the parent model and rely on independent contexts.

Every reviewer receives the same filled prompt, target, intent, rubric, and quality lens. Add this
boundary verbatim:

```text
READ ONLY. Do not edit files, commit, push, create pull requests, send messages, or mutate external systems. Return findings only.
```

Wait for all reviewer IDs with `wait-for-children`.

## Synthesize

1. Parse every finding.
2. Merge duplicates.
3. Mark findings raised independently by two or more reviewers as consensus.
4. Preserve lone findings when their evidence holds.
5. Record explicit disagreements.
6. Verify important claims against the code before accepting them.

Categorize every finding:

- **Act on.** A demonstrated correctness, security, data-loss, or maintainability problem that
  should block the change.
- **Consider.** A real tradeoff whose value may not exceed its cost now.
- **Noted.** Valid context with no present action.
- **Dismissed.** Incorrect, speculative, duplicated, or irrelevant to the stated intent.

For each item, name the reviewer labels, category, location, evidence, and judgment. Reviewer count
is not proof. Consensus raises priority; code and runtime evidence settle it.

## Output

Use this structure:

```text
Intent
Reviewers
Act on
Consider
Noted
Dismissed
Agreement map
```

Do not change code unless the user separately asks for the accepted findings to be fixed.

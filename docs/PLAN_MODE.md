# Plan mode

Get a plan before you get code.

Plan mode is a human-in-the-loop gate. The agent reads your request, proposes a markdown plan, and
stops. Nothing touches your branch until you approve. You can amend, reject, or accept — and you
pick which model implements the approved plan.

Use it when the task is non-trivial: refactor, redesign, multi-file change, architectural decision.
Skip it for typos, one-line fixes, or anything you can describe in a sentence.

## When plan mode kicks in

Plan mode is on by default for non-trivial requests, off for quick ones. The behavior is the same
across channels with one twist per channel.

| Channel    | Default                                   | How to force ON                                                                                                 | How to force OFF                                                                                 |
| ---------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Web**    | The `Plan` toggle in the composer is OFF. | Click `Plan` before submitting. The model selector swaps to the deployment's plan model.                        | Leave the toggle OFF.                                                                            |
| **Linear** | OFF unless labelled.                      | Add the `plan` label (or `plan-<alias>` to also override the plan model).                                       | Remove the label.                                                                                |
| **GitHub** | OFF unless labelled.                      | Same labels as Linear: `plan` or `plan-<alias>`.                                                                | Remove the label.                                                                                |
| **Slack**  | The bot decides from your message text.   | Either enable `Plan first, then build` in App Home, or write a prompt the classifier recognizes as plan-worthy. | Phrase your message as a small, well-scoped change ("quick fix", "rename", "small enhancement"). |

The Slack classifier reads your `@mention` and picks plan-vs-build. A "refactor the auth module to
use the new pattern" triggers plan mode; a "fix the typo in the homepage hero" goes straight to
build. The App Home toggle, when on, forces plan mode on every session regardless of phrasing.

## What happens when plan mode is on

1. The agent runs a planning turn. It can read files but cannot edit, run shell, or open a PR.
2. It produces a markdown plan with: a one-sentence restatement of your goal, an ordered list of
   concrete steps, and a short "Risks & open questions" section if anything is uncertain.
3. The session waits. The plan card carries a `Plan v1` header and an approval banner.
4. You **approve**, **reject**, or **amend** by sending a follow-up prompt.

The plan persists across turns. If you come back tomorrow, the next prompt re-anchors on the saved
plan instead of relying on conversational memory that may have been compacted.

## Approve, reject, amend

### Web

The approval banner sits above the composer with a `Build with` model picker and two buttons:
`Approve` and `Reject`. Approving dispatches an "Implement the approved plan vN" prompt with your
chosen model. Rejecting prompts for an optional reason and pauses the session. Clicking the
`Plan vN` pill scrolls to the top of the plan card.

### Linear

The bot pushes the plan to the issue as an elicitation activity. Reply in the same thread:

- `approve` — start the build (uses the model from a `model-<alias>` or `build-<alias>` label on the
  issue, else the default)
- `reject` — discard the plan; optionally add a reason on the same line
- Anything else — the agent treats it as an amendment and proposes plan v2

Switch the build model by adding a label like `build-sonnet` or `model-opus` before approving.

### GitHub

Same commands as Linear (`approve`, `reject [reason]`), posted as a PR or issue comment. Labels for
model overrides: `plan-<alias>`, `build-<alias>`, `model-<alias>`, `review-<alias>`.

### Slack

The bot posts a `Plan v1 — awaiting your approval` block with the plan body and three buttons:
`Approve`, `Reject`, and `View plan in web`. Approve opens a modal to pick the build model. Reject
opens a modal for an optional reason. Both close cleanly when submitted.

## Models

Plan mode uses two models per session:

- **Plan model** — runs the planning turn. Defaults to the deployment-wide `defaultPlanModel`
  (configurable in **Settings → Models → Default Models**).
- **Build model** — runs the implementation turn after approval. Defaults to `defaultModel`, but you
  can switch it per session at approve time.

The split matters: planning benefits from a more capable model since the resulting plan steers the
implementation; the build model can be cheaper. The deployment defaults are stored in D1 and read by
every bot at session-creation time — no Terraform redeploy needed to change them.

### Label aliases (Linear + GitHub)

Linear forbids `:` in label names, so we use dash-separated everywhere:

| Label            | Effect                                                     |
| ---------------- | ---------------------------------------------------------- |
| `plan`           | Trigger plan mode (plan model = deployment default)        |
| `plan-<alias>`   | Trigger plan mode AND override the plan model              |
| `model-<alias>`  | Override the build model                                   |
| `build-<alias>`  | Same as `model-<alias>`, reads more naturally in plan mode |
| `review-<alias>` | Override the model used to auto-review a PR                |

`<alias>` is the short name: `sonnet`, `opus`, `haiku`, `opus-4-7`, `gpt-5.4`, etc. The alias →
canonical model map lives in `@open-inspect/shared` so Linear and GitHub stay in sync.

## Settings → Models

Two dropdowns under **Default Models** read and write the deployment-wide defaults. Changes are
atomic; disabling a model that's the current default is blocked inline.

Bots (Linear, GitHub, Slack) call `GET /model-preferences` at session-creation time. Fallback chain:
`D1 > env var > shared constant`. If the control plane is unreachable, bots fall back to the shared
constant.

## Slack specifics

### App Home toggle

`Plan first, then build` — when ON, every session you start in Slack is gated by a plan. When OFF
(the default), the bot decides automatically from your prompt.

The toggle is per-user and stored in KV (`user_prefs:<slackUserId>`). Your toggle doesn't affect
anyone else.

### Smart detection

When the toggle is OFF, the repo classifier also decides plan-vs-build. It runs as part of the same
LLM call that picks the repo (or a dedicated lightweight call for the single-repo and channel-bound
fast paths). Decision rules:

- **Plan** — multi-step refactor / redesign / migration, feature spanning multiple files, "how
  should we" questions, anything where reviewing the approach before code changes adds clear value.
- **Build** — bug fix with clear scope, typo / rename / small enhancement, questions, explicit "just
  do X" or "quick fix", read-only investigations.

When uncertain, the classifier defaults to build to reduce friction. You can always re-prompt for a
plan.

## Architecture (high level)

```
@mention / label / web prompt
        │
        ▼
┌──────────────────┐      planMode flag      ┌─────────────────────────┐
│ control plane DO │ ───────────────────────▶│ sandbox bridge (Python) │
│  SessionService  │                         │   _handle_prompt        │
│   plans table    │◀── plan content ────────│  planning preamble +    │
│ approval gate    │                         │  <user_message> wrap    │
└──────────────────┘                         └─────────────────────────┘
        │                                              │
        │ broadcasts: plan_status                      │ OpenCode (agent)
        ▼                                              ▼
   Web / Linear / GitHub / Slack callbacks      Markdown plan emitted
        │
        ▼
   approve / reject / amend  ──▶ next prompt runs as build
```

Key invariants:

- **Plan persistence** — plans live in the SessionDO SQLite `plans` table with monotonic versions
  per session. v1 is `SUPERSEDED` once v2 lands. Approve/reject is terminal.
- **Dispatch gate** — while `plan_mode = 1` and `plan_approval_status = "awaiting_approval"`, every
  prompt is dispatched as a planning turn (amendments produce plan v2, v3, …). Approve or reject
  sets `isPlanningTurn` to false and subsequent prompts run as build turns.
- **Resume anchoring** — `_build_resume_preamble` injects the saved plan into the next prompt as
  `<resume_context><saved_plan>…</saved_plan></resume_context>` so the agent re-anchors even after
  context compaction.
- **Prompt safety** — bot-assembled content is wrapped in `<user_content>` blocks (HTML-escaped,
  `</user_content>` neutralized). The sandbox bridge wraps that block in `<user_message>` and also
  neutralizes literal `</user_message>` to prevent injection across the outer boundary.

## Endpoints (control plane)

| Method        | Path                         | Purpose                                                                              |
| ------------- | ---------------------------- | ------------------------------------------------------------------------------------ |
| `GET`         | `/sessions/:id/plan`         | Current plan + approval status                                                       |
| `POST`        | `/sessions/:id/plan`         | Save a new plan version (agent-source)                                               |
| `GET`         | `/sessions/:id/plans`        | List all plan versions for a session                                                 |
| `POST`        | `/sessions/:id/plan/approve` | Flip status to `approved`; optional `implementationModel` override                   |
| `POST`        | `/sessions/:id/plan/reject`  | Flip status to `rejected` with optional reason                                       |
| `GET` / `PUT` | `/model-preferences`         | Read/write deployment defaults (`defaultModel`, `defaultPlanModel`, `enabledModels`) |

The bots and web app proxy through their own API routes (`/api/sessions/[id]/plan/*`) for auth +
CSRF.

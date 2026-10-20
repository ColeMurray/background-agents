# Adversarial audit round 5 — upstream parity, the diagnostics surface, and the browser transport

Scope: the upstream Pi Durable contract, the sanitized diagnostics a Pi session shows, and the one
capability that had no implementation at all. This round read the upstream sources directly rather
than the installed package, and it asked one question of every remaining surface: _what does the
product say this must do, and does the code do it?_

## The upstream contract, verified against the sources

The published `@earendil-works/pi-durable` is still `1.3.0`, and upstream `main` still carries the
same version number while differing in content. This round read upstream `main` directly —
`README.md`, `src/harness/types.ts`, `src/harness/task-graph.ts`, `package.json` — instead of
inferring the contract from the installed package.

Three things changed what Open-Inspect does.

### The wake contract is exactly the shape Open-Inspect already used

Upstream `main` defines `Wake = { active: boolean; at?: number }`, `HarnessOptions.onWake`, and
`Harness.wake()`. Open-Inspect's `PiHarnessWake` is the same shape, field for field, and the
controller prefers the native `wake()` when the installed release exposes it. The parity seam is
correct and needs no change.

The documentation also says something Open-Inspect must now respect: `setTimer` is _declined in
Cloudflare Workers_, so the harness does not keep a Durable Object alive by itself. The host owns
the wakeup.

### The physical alarm already has an owner, and it is not Open-Inspect

The Cloudflare `agents` SDK's `PiHarness` keeps one `Lifecycle` job per session: the job waits while
pi has live tasks, reschedules itself as a heartbeat, and completes when there are none. The
`Lifecycle` derives the physical Durable Object alarm from its job queue and installs the object's
`alarm` handler. Upstream's own documentation states the guarantee: _an eviction mid-run leaves the
job due, so its alarm restarts the object, pi reopens and resumes its own tasks, and the job waits
again._

So the hibernation support the product asked for is in place, and it is in the right place. Two
rules follow, and both are now written down:

1. **Open-Inspect must never arm the alarm itself.** The `Lifecycle` owns the physical alarm; a
   second owner would overwrite it. `pi-harness-wake.ts` is the _resume_ seam, not the alarm owner.
2. `PiSessionDO.onStart()` resumes the harness when a hibernated object wakes with pending work,
   before it reattaches its relays.

`PI-UPSTREAM-PARITY.md` now records the verified upstream state, the two rules, and the features
Open-Inspect deliberately does not adopt, each with its reason.

### The published release has no restart limit yet

Upstream `main` parks a task that was cut off too many times, with the reason `restart_limit`, and
`harness.retryTask(id)` runs it again. The published `1.3.0` has neither the limit nor the reason,
so Open-Inspect cannot rely on it yet. What it _can_ do is name the reasons the published release
does have — which is the finding below.

## The finding: a blocked task said nothing about why

`sanitizeInspection` and `inspectAgents` mapped a task's state to its kind, so a task that could not
run appeared as `blocked` with no reason at all. A missing task definition, a task whose definition
was too old, and a failed migration were indistinguishable. The operator surface is called
_diagnostics_; a diagnostic without the reason is a puzzle.

The fix names the reason in the fixed vocabulary Pi publishes, bounds the detail behind it, and
keeps it out of the model's way: `missing_task`, `task_too_old`, and `migration_failed` now reach
the inspection, and the agent inspection names the reason too. The sanitizer moved into its own
module so it is unit-testable without a Worker runtime.

## The browser transport

The browser was the last capability with a boundary and no implementation. It now has both.

### What was already there

The session's browser gateway, the capability gate, the live deployment mode, the reviewed host
allowlist, the actor attribution, and the activity on the session timeline. The audit of round 4 had
found the one hole in it — the delegate sent no URL, so the gateway always answered 400 — and that
was fixed.

### What was added

- **The tool.** A `browser` tool that carries a page and an action, and nothing else. It never
  carries a browser client, a cookie, a credential, or a session handle. It is owned by the browser
  policy delegate, so the assembler refuses to install it without an owner, and the owning session
  authorizes every call.
- **The transport.** Every page is loaded in a fresh browser with no cookie jar of its own. One
  session can never see another session's browser state, and a page can never inherit a human's
  cookies — not because the code clears them, but because there is no jar to inherit from. The
  transport resolves per call, so no browser handle is captured in a long-lived closure.
- **The bounds.** The page text is cut to 32 KiB, the screenshot to 1 MiB, and the request to 30
  seconds. The cut is stated rather than hidden.
- **The untrusted content.** A page can say anything. The result wraps the page's words in
  `<untrusted-page-content>` and says plainly that the content is untrusted data, never instruction.
  The tool's own section says the same to the model before it opens anything.
- **The failure.** The platform's own error never reaches the model. The model learns that the page
  could not be loaded; the detail stays inside the platform.
- **The sensitive actions.** Logging in, uploading, and downloading act on a site that belongs to
  someone else. The tool does not offer them, and the gateway refuses them _by name_ with
  `browser_action_needs_approval`, so a later caller cannot reach them by accident. The approval
  path itself is still open, and is listed as open.
- **The binding.** The `BROWSER` binding is staged by Terraform only when the operator asks for the
  browser capability, so a deployment that does not use it is unchanged, and a deployment that does
  gets a worker with a browser. The capability is still off by default, and the transport is
  unavailable without the binding, so the tool is simply not installed.

### What the browser still does not do

It does not log in, upload, or download, because those need a human approval path that does not
exist yet. It does not keep a persistent browser session, so there is no per-session cookie state to
clean up on archive or delete. It does not have a live human-facing view of the browser, and it does
not have a canary.

## The lanes

| Lane                    | Result                   |
| ----------------------- | ------------------------ |
| control-plane unit      | 5,405 passed (338 files) |
| Terraform               | 113 passed               |
| workflow contracts      | 13 passed                |
| lint, format, typecheck | clean                    |

The workerd lane and the web lane are the last to run; their results are in the handover.

## What this round does not close

- The browser canary, its accessibility review, and the approval path for the sensitive actions.
- The MCP transport and its OAuth lifecycle, unchanged from the earlier rounds.
- The provider canaries for external publication.
- The restart limit and `retryTask` from upstream `main`, which the published release does not have
  yet. When it lands, the parked reason arrives in the same place the other reasons already do.

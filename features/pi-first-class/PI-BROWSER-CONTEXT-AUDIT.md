# The browser's session context — the audit

This is the audit of brief 6 in `PI-REMAINING-AUDIT-BRIEFS.md`. It was read against commit
`a6ab76de` (`feat/pi-go-live-integration-v2`), with the questions answered from the code, the
`agents` SDK in `node_modules/agents/dist/`, and Cloudflare's own documentation. The repo's own
documents are treated as claims to be checked, not as evidence.

The line references below point at the state this change commits. Where a line moved because of this
change, the symbol is named so the reference still resolves.

---

## 1. What the code does today

### 1.1 The transport is one-shot, and it is a Quick Action

`packages/control-plane/src/cloudflare/browser-rendering-transport.ts:40` builds a single URL:

```
https://browser-rendering-endpoint/{markdown|screenshot}?url=<the page>
```

and fetches it. That is a Browser Run **Quick Action** (`/markdown`, `/screenshot`), which
Cloudflare documents as "stateless one-shot tasks (screenshot, PDF, markdown, structured extraction,
…) — no session, no token, just the binding" (`agents/dist/connector-DEXzVoaY.d.ts:21-23`, and
<https://developers.cloudflare.com/browser-run/quick-actions/>).

Consequences that matter:

- **No cookie jar exists.** The Quick Action is a request, not a browser that lives. The repo's
  claim that "one session can never see another session's browser state"
  (`features/pi-first-class/AUDIT-ROUND-5.md:84-86`) is true, and the reason is stronger than the
  repo states: there is no jar to inherit from at all.
- **The isolation is Open-Inspect's code, not the platform's.** The same Quick Action accepts a
  `cookies` array and an `authenticate: {username, password}` pair
  (`agents/dist/connector-DEXzVoaY.d.ts:54-58`). Open-Inspect never passes them
  (`browser-rendering-transport.ts:37-71`), so the isolation holds — but it holds because of what
  this repository does not send.
- **Quick Actions cannot be given hostname guardrails.** Cloudflare: "Session guardrails apply to
  browser sessions created with Puppeteer, Playwright, or CDP. They are unavailable for Quick
  Actions" (<https://developers.cloudflare.com/browser-run/features/guardrails/>). See §5.2.

### 1.2 The session's gateway authorizes every request

`packages/control-plane/src/session/http/handlers/browser-gateway.handler.ts` is the authority seam,
and it is already complete:

| Check                                                                   | Where                                                                                              |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| the session's latched capability                                        | `browser-gateway.handler.ts:115-121` (`sessionCapability() === "off"`)                             |
| the live deployment mode                                                | `browser-gateway.handler.ts:115-121` (`liveMode() === "off"`)                                      |
| the turn belongs to this session                                        | `browser-gateway.handler.ts:129-135`                                                               |
| the turn has a workspace actor                                          | `browser-gateway.handler.ts:136-143`                                                               |
| `login` / `upload` / `download` are refused **by name**                 | `browser-gateway.handler.ts:144-156`                                                               |
| only `read` and `screenshot` are offered                                | `browser-gateway.handler.ts:157-163`, `pi/browser-transport.ts:16`                                 |
| http/https only                                                         | `browser-gateway.handler.ts:172-180`                                                               |
| the host is on the reviewed list, wildcards never match the bare domain | `browser-gateway.handler.ts:189-195`, `hostMatches` at `:318-330`                                  |
| the decision is on the session's timeline                               | `record()` at `:200-213`, written by `session/components.ts:953-964` as a `browser_activity` event |

The reviewed host list is deployment configuration, read by the session
(`session/components.ts:937-941`, `PI_BROWSER_ALLOWED_DOMAINS`) — never by the model.

### 1.3 What the model receives

`packages/control-plane/src/pi/browser-extension.ts` exposes one tool, `browser`, whose parameters
are `action` (`read` | `screenshot`) and `url`. It carries no browser client, no cookie, no
credential, no session handle. The page text is wrapped in `<untrusted-page-content>` and the
wrapper says the content is data, never instruction (`pi/browser-transport.ts:83-111`). The bounds
are 32 KiB of text, 1 MiB of screenshot, 30 s per request (`pi/browser-transport.ts:43-49`).

### 1.4 Collaborator-visible activity and actor attribution are already there

`browser_activity` events carry the url, the outcome, the reason, and the actor
(`session/components.ts:953-964`), and the web client renders them
(`packages/web/src/components/session-timeline.tsx:707-720`). The event's `messageId` is the
operation id, and the operation's canonical actor is resolved from the message row
(`session/components.ts:942`, `messageRepository.getMessageHumanActor`).

### 1.5 There is nothing to clean up

There is no persistent browser state anywhere: no browser session id, no cookie jar, no store.
`SessionLifecycleHandler.archive()` (`session/http/handlers/session-lifecycle.handler.ts:147-182`)
does not touch the Pi Durable Object at all, and `PiSessionDO.destroy()`
(`cloudflare/pi-durable-object.ts:1216-1266`) clears the Durable Object's storage. The repo's own
statement — "It does not keep a persistent browser session, so there is no per-session cookie state
to clean up on archive or delete" (`AUDIT-ROUND-5.md:107-109`) — is **true as written**.

---

## 2. The brief's four questions

### Q1. What does a persistent per-session context actually buy the product?

Three candidate benefits, and only one of them is real:

- **Continuity / a logged-in session.** Not usable today, and not usable _by construction_. `login`,
  `upload` and `download` are refused by name (`browser-gateway.handler.ts:144-156`), the approval
  path that would have to admit them does not exist, and the model-facing tool offers only `read`
  and `screenshot` (`pi/browser-transport.ts:16`). A cookie jar would be dead weight until a human
  approval path exists — and the moment one exists, a per-session jar becomes a credential store
  that needs its own cleanup and its own revocation story.
- **A live view.** Does not exist at all: `grep -rn "liveView" packages/` returns nothing. It is a
  _separate human-facing feature_, not a property of the browser context, and it is answered in
  §5.4.
- **Egress containment.** This one is real, and it is the only thing a Browser Run _session_ buys
  over a Quick Action. See §5.2.

**The one-shot form is stronger on isolation and weaker on reach.** For everything the product can
actually use today, it is sufficient.

### Q2. Would the browser's session record live in Pi's SQLite? Would its scope need the SessionDO's authority?

Yes and yes, and that is the tension.

- The `agents` `Browser` is a `LifecycleCapability` (`agents/dist/browser-D30VlpcA.d.ts:239`), so it
  is installed on a Durable Object's `Lifecycle` — here, the Pi Durable Object
  (`cloudflare/pi-durable-object.ts:610-613`). Its record is kept in a `BrowserSessionStore`; the
  default is a `DurableBrowserSessionStore` over "the host object's storage"
  (`agents/dist/browser-D30VlpcA.d.ts:146-151`, `agents/dist/session-store-DoPY12xM.d.ts:333-342`).
  In the Pi Durable Object that is Pi's SQLite, beside Pi's tables.
- Its _scope_ would have to come from the SessionDO, exactly like every other capability, because
  the reviewed host list, the capability latch, the live mode and the actor are the SessionDO's
  facts (`session/components.ts:932-946`). But the `agents` `Browser` reads its `guardrails` from
  the options it is constructed with (`agents/dist/browser-D30VlpcA.d.ts:110-117`), and the Pi
  Durable Object would have to be _given_ that list — a second copy of Open-Inspect's authority,
  living on the Pi side, that can disagree with the one the gateway enforces.
- The `agents` scope is also not what the product phrase means. `BrowserConnectOptions.scope`
  "splits 'which tab is mine', not the browser": cookies, logins and tabs are shared by every scope
  (`agents/dist/browser-D30VlpcA.d.ts:174-186`).

So a persistent browser would put a Pi-side record of an Open-Inspect-owned resource on the Pi side.
That is the single-tenant tension, stated plainly: **there is no place in this architecture for a
session-scoped browser record that is owned by the session rather than by Pi.**

### Q3. Which guardrail list is authoritative, and what happens if they disagree?

Today there is only one list, and it is the SessionDO's: `PI_BROWSER_ALLOWED_DOMAINS`, read by the
session (`session/components.ts:937-941`) and enforced by the gateway
(`browser-gateway.handler.ts:189-195`). It is authoritative.

The `agents` `Browser` has its own: `BrowserRunOptions.guardrails`
(`agents/dist/browser-D30VlpcA.d.ts:110-117`), a hostname allowlist fixed at session launch
(<https://developers.cloudflare.com/browser-run/features/guardrails/>). If both existed and
disagreed, the answer has to be: **the SessionDO's list is the authority; the platform guardrails
are derived from it, never the other way round, and a request the gateway refuses is refused even if
the platform would have allowed it.** The platform list can only ever be _narrower_ (it must also
cover the page's own sub-resources, which the operator's list may not); the gateway's list is the
outer bound.

The two lists cannot be allowed to disagree silently, which is why the guardrails must be _derived
from_ the session's list at the moment the browser is created, not configured separately.

### Q4. Where would the live view live, so it never reaches the model context?

The `agents` `Browser.liveView()` returns URLs that "are bearer credentials with a short connect
window (~5 min) — hand them to a trusted human, never to the model, and never store them: re-mint
instead" (`agents/dist/browser-D30VlpcA.d.ts:270-280`). Cloudflare agrees: "Treat Live View URLs as
credentials. A Live View URL contains a signed `jwt` value" and "Generate Live View URLs from
trusted server-side code" (<https://developers.cloudflare.com/browser-run/features/live-view/>).

So the live view belongs on a **human-facing SessionDO route**, minted on demand for a user who
holds the session's authority, and never in the Pi tool registry, never in a tool result, never in
the timeline, and never in a log line. It is re-minted per request, because the URL expires. The
repo already states the rule correctly (`STATE-AND-HANDOVER.md:468-470`, and
`MULTIPLAYER-COMPATIBILITY-AUDIT.md:111`).

---

## 3. The verdict

**Bucket: B for the part that was implemented, C for the part that was not.**

| Question                                                        | Verdict                                                                                             |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Does the product need a persistent per-session browser context? | **No.** Not for anything it can use today. The one-shot form is sufficient and strictly safer.      |
| Is there a boundary deviation in the code as audited?           | **Yes** — the Pi Durable Object held the browser binding and drove the browser itself.              |
| Was it unambiguous?                                             | **Yes** — the repo states the rule in two places and has a working precedent. Fixed in this change. |
| Does the persistent context require a new primitive?            | **Yes** — bucket C. Reported in §5, not built.                                                      |

### The deviation that was fixed

`STATE-AND-HANDOVER.md:13-23` states the one rule:

```text
Pi task
  → owning SessionDO authorizes it (current actor, session, team, workspace, resource authority)
  → D1 resolves current authority
  → capability-specific durable gateway executes it
  → result returns through SessionDO audit / timeline / budget
  → Pi receives only a bounded, credential-free result
```

and `MULTIPLAYER-COMPATIBILITY-AUDIT.md:111` states it for the browser specifically: "The binding
stays behind a SessionDO gateway; Pi never receives it directly."

As audited, the browser broke that rule in two places:

1. **The binding was on the Pi side.** `PiWorkerBindings` picked `"BROWSER"` and the Pi Durable
   Object constructed the transport from `this.env.BROWSER` (both lines are gone in this change;
   `cloudflare/pi-durable-object.ts:173` is the narrowed type now). The Pi Durable Object is Pi's
   runtime; it held the privileged client.
2. **The result did not return through the SessionDO.** The Pi Durable Object called the SessionDO,
   got a boolean, and then fetched the page itself — that was the tool's `execute` before this
   change. The authorization and the effect were two separate operations in two different objects,
   so the request that was authorized was not necessarily the request that ran.

The MCP capability shows what "right" looks like in this codebase: the Pi Durable Object asks the
session to read, and the **session's** gateway performs the provider call and returns the bounded,
credential-free result (`session/http/handlers/mcp-session.handler.ts:195-441`,
`session/contracts.ts:128` `piMcpRead`). The browser now has the same shape.

**The exploit scenario this closes.** The gateway's decision and the browser's fetch were separated
in time and in object. Between the SessionDO answering "allowed" and the Pi Durable Object fetching,
the deployment's reviewed host list could change — an operator removing a host after seeing it used
does not stop the fetch that is already in flight, and nothing in the code binds the fetched URL to
the authorized URL. Under the change, the URL that is authorized is the URL that is fetched, in one
object, in one operation.

---

## 4. What this change implements

**The browser's execution moves behind the SessionDO's gateway.** No new table, no new scope, no new
auth path, no new capability, no new binding.

### 4.1 Exact reuse

| Reused                                                                                       | Where                                                                                             |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| the reviewed host list, the capability latch, the live mode, the turn attribution, the actor | `session/http/handlers/browser-gateway.handler.ts` — unchanged                                    |
| the sensitive-action refusal by name                                                         | `browser-gateway.handler.ts:144-156` — unchanged                                                  |
| the one activity event per page                                                              | `record()` at `:200-213` — unchanged; the early gate still sends no action, so it records nothing |
| the one-shot transport and its bounds                                                        | `cloudflare/browser-rendering-transport.ts` — unchanged, only its owner moved                     |
| the untrusted-content wrapper and the model-facing text                                      | `pi/browser-transport.ts:83-111` — unchanged                                                      |
| the MCP gateway's shape for a capability the session executes                                | `session/http/handlers/mcp-session.handler.ts` — the precedent                                    |

### 4.2 What is new

| New                                                                                                     | Where                                                                                       |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| a `BROWSER` port on the platform, so the binding is adapted once and the port is what the session holds | `src/types.ts` (`Platform.BROWSER`), `src/cloudflare/platform.ts` (`createCloudflareEnv`)   |
| `BrowserGateway.readRequest()` — authorize, record, then act                                            | `session/http/handlers/browser-gateway.handler.ts:259-312`                                  |
| an internal route the Pi session calls to read a page                                                   | `session/contracts.ts` (`piBrowserRead`), `session/http/routes.ts`, `session/components.ts` |
| the Pi tool's single call to the session                                                                | `pi/browser-extension.ts` (`BrowserToolOptions.read`)                                       |
| the Pi Durable Object's client                                                                          | `cloudflare/pi-durable-object.ts` (`readBrowser`)                                           |

### 4.3 What is gone

- `PiWorkerBindings` no longer picks `"BROWSER"`. **The Pi Durable Object has no browser binding.**
- The Pi Durable Object no longer constructs a transport, and the tool no longer calls a transport.
- The Pi tool's separate `authorize` call is gone: one call now authorizes, records, executes and
  returns, inside the session.

### 4.4 Behaviour changes worth naming

- The browser tool is now installed whenever the session's latched capability allows it. Previously
  the Pi Durable Object also checked whether the deployment staged a browser binding, and omitted
  the tool when it did not. The tool is now always present when the capability is on, and the
  session refuses it with `browser_unavailable` when the deployment stages no browser
  (`browser-gateway.handler.ts:122-127`). The failure is closed, and it is decided by the authority
  rather than inferred by the runtime.
- The session's `browser_activity` event is unchanged: one per page, with the url, the outcome, the
  reason and the actor.

---

## 5. What this change deliberately does not do, and why

### 5.1 A persistent per-session browser context — bucket C, a product decision

Building it needs a **new primitive**: a browser session record whose scope is an Open-Inspect
session but whose home is a Durable Object. The two possible homes are both wrong today:

- **In the Pi Durable Object.** The record is Pi-side state for an Open-Inspect-owned resource, and
  the guardrails would have to be handed to Pi, which creates a second copy of the reviewed host
  list that can disagree with the session's (§2 Q3). The repo already draws this line for the
  Computer VFS, which is Pi's own workspace and not a provider-facing capability
  (`MULTIPLAYER-COMPATIBILITY-AUDIT.md:63-67`); a browser is provider-facing.
- **In the SessionDO.** The `agents` `Browser` is a `LifecycleCapability` and the SessionDO does not
  compose a `Lifecycle`; giving it one is a much larger change than the browser itself.

And the benefit is not yet reachable: without the approval path for `login`, continuity buys nothing
(§2 Q1), and the model-facing surface that would make it valuable — the `agents` `browserTool`,
which runs **model-written JavaScript** against the CDP (`agents/dist/browser/tools/pi.d.ts:96`, and
`agents/dist/browser-tool-vtrPOV8e.d.ts`) — needs a `LOADER` worker-loader binding and a separate
Worker that exports `CodemodeRuntime`, which is a new deployment surface and a much larger safety
question than a page read.

**Recommendation: do not build it until there is a human approval path for `login`, a live-view
route, and a decision about model-written browser code.** The one-shot transport plus the session
gateway is the safe and sufficient form for what exists.

### 5.2 Egress containment — reported, not fixed, and it needs the canary

**This is the most important finding in the audit, and it is not fixed here.**

The reviewed host list bounds the URL the agent _names_. It does not bound what the browser
_reaches_. Quick Actions have no guardrails (§1.1), so a page on an allowed host can redirect the
browser anywhere, and can load scripts, images, iframes and XHR from anywhere. The session's
timeline will say "Browser opened https://allowed.example/page" while the browser fetched
`https://not-allowed.example/…` on the way.

The repo's own wording overstates what the code delivers. As audited,
`browser-rendering-transport.ts:23-24` said "The deployment decides which hosts the session may
reach", and `browser-gateway.handler.ts:8-11` said "the pages it may reach must be the ones an
operator reviewed". Today, only the _named_ page is reviewed. This change corrects both comments to
say what the code does; the gap itself is not closed here.

Closing it requires a Browser Run **session** with `guardrails`
(`agents/dist/browser-D30VlpcA.d.ts:110-117`) and a CDP-driven reader — that is, replacing the Quick
Action transport with a session transport, driving navigation and extraction over CDP, and deleting
the session afterwards. It also costs more (a session is a real browser instance, not a stateless
request), and it cannot be validated without a deployment that has Browser Rendering. The repo's own
open list already names "The browser canary" as outstanding (`STATE-AND-HANDOVER.md:486-490`).

**This change puts the transport behind the gateway, so the swap is now one object in one place
(`session/components.ts:947-952`) rather than a change inside the Pi runtime. That is the seam; the
transport swap itself is a separate piece of work with a canary of its own.**

### 5.3 A live view — a separate human-facing feature

Answered in §2 Q4: a SessionDO route, minted on demand for a user who holds the session's authority,
never in the model context, re-minted per request because the URL expires. It needs a persistent
browser to attach to, so it is downstream of §5.1.

### 5.4 Cleanup on archive and delete — nothing to clean

Verified in §1.5: there is no persistent browser state, so archive and delete have nothing to
reclaim. When a persistent context is ever built, the cleanup obligation lands in
`PiSessionDO.destroy()` (`cloudflare/pi-durable-object.ts:1216-1266`) for delete, and **archive
needs a new hook that does not exist today** — `SessionLifecycleHandler.archive()` never reaches the
Pi Durable Object (`session/http/handlers/session-lifecycle.handler.ts:147-182`), so a persistent
browser would outlive an archived session until the platform reclaimed it.

---

## 6. UNVERIFIED

Things this audit could not verify from the repository, and their sources.

1. **Whether the current transport works against the binding at all.** The transport issues
   `GET https://browser-rendering-endpoint/markdown?url=…`
   (`cloudflare/browser-rendering-transport.ts:40`). The Quick Actions documentation shows the REST
   form as `POST` with a JSON body, and the Workers binding's typed form as
   `env.BROWSER.quickAction("markdown", {url})`
   (<https://developers.cloudflare.com/browser-run/quick-actions/markdown-endpoint/>). I could not
   confirm from the docs that the binding accepts the GET-with-query form this transport uses. The
   repo lists the browser canary as outstanding (`STATE-AND-HANDOVER.md:486-490`), which is
   consistent with this never having been exercised against a live binding. **Treat the transport's
   wire format as unverified.**
2. **The cost of a browser request.** Quick Actions report browser time in the `X-Browser-Ms-Used`
   response header (<https://developers.cloudflare.com/browser-run/quick-actions/>). The transport
   discards that header (`browser-rendering-transport.ts:43-46`), and the session's budget does not
   account for browser time. I did not trace the budget service deeply enough to state whether
   browser time could be metered; I did not find any place where it is.
3. **Whether `agents@0.28.1` on npm is byte-identical to the copy in `node_modules`.** The lockfile
   pins `agents@0.28.1` with integrity
   `sha512-rhQax1hg0v4QWQhkIH3W2kywrj55fsHde3E+bSnsGkv2gH5nJUVyw6o6xeVnQrCbaLt8YXMhGw+hj4v82at/4g==`
   and `npm ls agents` resolves to `0.28.1`, so the installed tree is the published package. The
   _content_ of that package's browser API was read directly from `node_modules/agents/dist/`.
4. **Live deployment behaviour.** No Browser Rendering binding, no canary, no live Pi session was
   available. Every statement about runtime behaviour is a statement about the code.
5. **Browser Run session limits and pricing**
   (<https://developers.cloudflare.com/browser-run/limits/>) were not used in a cost calculation;
   §5.2's "costs more" is qualitative.

---

## 7. Where this reading differs from the repo's own documents

1. **`MULTIPLAYER-COMPATIBILITY-AUDIT.md:80-81` is wrong.** It says "The pinned `agents@0.28.1`
   package does not export the current Browser APIs." It does export them. The installed,
   lockfile-pinned `agents@0.28.1` exports `Browser`, `browserRun`, `BrowserLiveView`,
   `BrowserConnector` and `DurableBrowserSessionStore` from `agents/browser`
   (`node_modules/agents/dist/browser/index.d.ts:82-158`), and `browserTool` from
   `agents/browser/pi` (`node_modules/agents/dist/browser/tools/pi.d.ts:96`). The section header —
   "Browser Run, Agents Browser, and Kitesurf (**not implemented**)" — is also stale: the repository
   _does_ stage the `BROWSER` binding
   (`terraform/environments/production/workers-control-plane.tf:77-79`) and _does_ have a browser
   tool.
2. **`MULTIPLAYER-COMPATIBILITY-AUDIT.md:111` was right and the code disagreed with it.** "The
   binding stays behind a SessionDO gateway; Pi never receives it directly" was not true of the code
   as audited. This change makes it true.
3. **`cloudflare/platform.ts:35-41` stated the opposite design** ("It is read by the Pi Durable
   Object, which is the only component that drives a browser"). That comment was accurate about the
   code and wrong about the rule; it has been corrected.
4. **`AUDIT-ROUND-5.md:84-86` and the transport's own comment overstate the host allowlist.** They
   describe the reviewed list as what the browser "may reach". It is what the agent may _name_; the
   browser itself is not confined to it (§5.2). The transport's comment is corrected in this change;
   the handover note is not.
5. **`STATE-AND-HANDOVER.md:290-296` frames the choice as "one-shot vs a persistent context" and
   assumes the persistent one is the goal.** The audit's answer is that the choice is not "one-shot
   vs persistent" but "page read vs browser automation", and that the second has not been decided.
6. **The spec phrase "one browser context scoped to the Open-Inspect session" is quoted in
   `STATE-AND-HANDOVER.md:293` but appears nowhere else in the repository.** A whole-repository
   search finds exactly one occurrence, in that handover note. There is no spec file in the tree to
   check it against, so the phrase is treated here as a product intent rather than a requirement
   with a definition.

---

## 8. What a human has to decide

1. **Does the product want browser automation at all, or page reads?** The answer decides whether
   §5.1 is ever built. The current tool reads a page the model names; it cannot click, type, or
   follow a flow.
2. **If yes: where does the browser's session record live?** It cannot live in Pi's SQLite without a
   second copy of the reviewed host list, and the SessionDO does not compose a `Lifecycle` today.
3. **Is the egress gap (§5.2) a release blocker?** It is a gap between what the deployment's
   reviewed-host list claims and what it enforces. Closing it needs a session transport and a
   canary.
4. **Should the browser's time be metered into the session budget?** It is a real cost that is
   currently invisible.

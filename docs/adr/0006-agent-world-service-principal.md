# ADR 0006: Dedicated service principal for Agent World

Date: 2026-09-30

Status: Accepted

## Context

Agent World is a separate product that presents quests in a town view and keeps its own
authoritative quest journal and approvals. It uses Open-Inspect as its execution backend: it creates
sessions, follows their events and artifacts, and stops them. It needs a server-to-server
credential. The existing sig1 services are workers inside this deployment (web, Slack, GitHub,
Linear). Borrowing one of their keys would blur attribution and grant that bot's ceiling and
actorless routes to an unrelated caller.

## Decision

Add an `agent-world` sig1 service with its own key.

- **Actors.** It asserts `github:<id>` actors, and only for identities that already exist. An
  unknown actor fails authentication and is never enrolled. Calls without an actor are denied: no
  route grants `agent-world` actorless access.
- **Ceiling.** `repositories.read|use`, `sessions.create|read|collaborate|lifecycle`, `skills.read`.
  Environments, integrations, sandbox access, and every management permission stay outside it. The
  acting member's role still applies on top of the ceiling.
- **Route allowlist.** Permissions are bundles: `sessions.collaborate` also admits pull-request
  creation, Slack notifications, and uploads. Agent World may therefore call only these routes,
  checked after authentication and before any RBAC lookup: `GET /repos`, `POST /sessions`,
  `GET /sessions/:id/events|artifacts|messages`, and `POST /sessions/:id/prompt|stop`. Anything
  else, including routes later added to one of its permissions, returns `service_route_not_allowed`.
- **Preallocated session IDs.** Like the Linear bot, it may supply `managedSessionId` so it can
  persist the ID before creating a session and reconcile a lost response instead of blindly retrying
  it.
- **Default off.** Terraform generates the key only when `enable_agent_world_service = true` and
  exposes it as a sensitive output. Without a bound key, every `agent-world` request fails.

## Alternatives

- **Reuse the Linear bot key or dispatch through Linear.** Rejected as the primary path: shared
  credentials and Linear-specific identity. Dispatch through Linear remains possible for manual use.
- **Allow actor enrollment like the chat bots.** Rejected: Agent World authenticates its own users,
  and Open-Inspect should not create members from an external service's assertion.
- **Permission ceiling alone.** Rejected after review: `sessions.collaborate` would let Agent World
  open pull requests through `POST /sessions/:id/pr`, outside its approved-commit publishing flow,
  and post Slack notifications. The allowlist keeps the ceiling as a second limit.
- **Deny specific routes instead of allowing specific routes.** Rejected: a route added later to one
  of the permissions would be open to Agent World by default.

## Consequences

Agent World sessions record `spawn_source = agent-world`, count as human-initiated in analytics, and
resolve provider accounts in unattended mode. `GET /sessions/:id` stays human-only; Agent World
reads status from events, including `execution_complete`. The AWS deployment module does not bind
this key.

## Revisit conditions

Revisit if Agent World needs environment targets or a route outside the ceiling, if more than one
external caller needs this pattern (generalize it), or if pull-request creation must be gated per
session.

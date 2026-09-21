# COL-106: Node control plane to bot workers over HTTPS

## Current contract

COL-52's replacement (#1993) moves callback delivery to the shared jobs consumer. That consumer and
the scheduler consume `SLACK_BOT` / `LINEAR_BOT` as the existing small `FetchClient` port.
Cloudflare supplies service bindings; Node currently omits these clients. Scheduler completion/skip
notifications and thread-context requests use the same port and must work without bespoke call-site
rewrites.

Outbound callbacks use HMAC over the exact JSON payload, with the signature in the body. They do
**not** use sig1 headers. The callback receivers verify that body. Separately, sig1's canonical
request includes method, path, query and body digest, not the origin. The adapter changes only the
origin; neither protocol needs a new signing scheme or key.

## Implementation plan

1. Add `src/node/url-fetch-client.ts`, implementing the existing `FetchClient`. Accept string, URL
   and Request inputs plus RequestInit overrides; resolve internal paths onto one configured bot
   origin. Preserve path, query, method, headers and body bytes. Allow only `https://internal`,
   relative paths or the configured origin as inputs; never let a request override the destination.
2. Validate configured origins at construction: HTTPS, no credentials, no path prefix, query or
   fragment. HTTP is allowed only for exact loopback hosts for local verification. Reject redirects,
   including caller attempts to enable redirect following: signed bodies must not be forwarded to
   another origin.
3. Keep attempt deadlines in canonical delivery callers on both hosts, using one shared ten-second
   constant. The transport preserves caller cancellation through response-body handling and adds no
   deadline or retries of its own. Jobs and scheduler helpers retain ownership of retry policy. No
   new HTTP framework, SDK or dependency.
4. Add optional `SLACK_BOT_URL` and `LINEAR_BOT_URL` to Node host settings, its config inventory and
   `.env.example`. In Node boot, build configured clients before opening data files; require the
   corresponding existing service secret when a URL is supplied. Unset URLs leave optional clients
   absent. Cloudflare wiring remains unchanged. Strip clients from session environments as COL-52
   does.
5. Document Compose configuration and AWS `config` map/SSM wiring. The existing AWS Terraform module
   already forwards arbitrary config keys, so no duplicate Terraform variables are needed. Require
   operators to supply the existing receiver keys directly; do not generate independent values.

## Verification

- Unit transport tests: all input forms, RequestInit overrides, unchanged signed bytes,
  URL/path/query mapping, foreign-origin refusal, invalid configuration, redirect refusal, caller
  cancellation and request/body deadlines.
- Run real callback handlers through the URL client into a local bot HTTP endpoint; verify
  destination body HMAC for Slack completion/tool callbacks and Linear starts, stable producer time,
  and unchanged host retry outcomes.
- Node host test: URL configuration actually populates both clients, absent configuration stays
  absent, and invalid/unsigned configuration fails boot before data creation. Existing Cloudflare
  integration tests remain green.
- Build both targets, typecheck, lint, and run relevant Node/config/callback and scheduler tests.
  Publish a ready-for-review PR stacked on #1993.

## Scope boundary and live acceptance

This is control-plane-to-bots transport only. Bot-to-control-plane fallback (COL-107), custom
domains/Modal allowlist, and staging deployment remain separate. No production bot messages, secret
changes, infrastructure apply or deployment are part of this implementation. The ticket's real
Cloudflare/Compose acceptance requires isolated staging bot identities; report it as unverified
until that environment is available, not as passed based on local signed-delivery tests.

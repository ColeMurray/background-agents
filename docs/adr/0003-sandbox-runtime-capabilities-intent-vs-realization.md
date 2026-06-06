# ADR 0003: Sandbox Runtime Capabilities — Intent vs. Provider Realization

## Status

Accepted

## Context

Docker support for Modal sandboxes (PR #697) surfaced a layering problem at the control-plane ↔
sandbox-provider boundary. Docker is the first of several runtime capabilities that will span
providers: Daytona will gain Docker, Vercel is being added (also Docker-capable), and the end state
is most providers supporting Docker while it stays optional for some. Modal is the odd one out —
Docker there is an experimental opt-in that uniquely requires a different base image, a launch flag,
in-sandbox network plumbing, and dockerd supervision, so on Modal "Docker on" ⟺ "a different image
lineage." Other providers will not couple Docker to image identity.

The initial implementation entangled three distinct concepts and shipped the wrong one across the
boundary:

- The provider-agnostic **intent** (`dockerEnabled`) was discarded at the boundary.
- A Modal-named **image profile** was shipped to every provider as the Docker signal, conflating the
  (shareable) environment **identity** with Modal's concrete image **realization**.
- Provider identity was re-derived by string comparison (`=== "modal"`, `isModalSandboxBackend`) in
  routes, the durable object, and the web app, so adding Docker to a second provider meant growing
  OR-lists across three packages.

## Decision

1. **Capabilities are the single source of truth.** `SandboxProviderCapabilities` and a
   `PROVIDER_CAPABILITIES` table live in `@open-inspect/shared`. Providers set their capabilities
   from the table; routes, the durable object, and the web app gate behavior on capabilities
   (`supportsDocker`, `supportsPrebuiltImages`, `supportsDashboardUrl`, …) via
   `getProviderCapabilities`. Code must not branch on the provider **name** outside the provider
   factory. Distinct features get distinct flags — "is modal" never stands in for an unrelated
   capability.

2. **Intent crosses the boundary; providers realize it.** `RequestedSandboxRuntime` (e.g.
   `{ docker }`) is declarative, provider-agnostic intent carried on `CreateSandboxConfig` /
   `RestoreConfig`. Each provider translates intent into its own mechanism. Intent crosses even when
   the environment id alone does not encode behavior — a provider with Docker in its base image
   realizes the same environment yet still must start dockerd.

3. **Environment identity is shared; image realization is provider-private.** The logical
   environment id (`SandboxImageProfile`: `"default" | "docker"`, …) is a shared, typed concept. A
   single `resolveEnvironment(intent, capabilities)` maps intent → environment id and enforces
   capability gating. The lifecycle manager speaks only this shared id (snapshot/prebuilt-image
   compatibility keys on it) and never sees a concrete provider image. Each provider maps the id to
   a concrete image internally.

4. **On Modal, `docker ↔ image_profile` is intentionally 1:1 and Modal-specific, and the Modal HTTP
   wire is frozen.** The Modal provider realizes the shared environment id as its `image_profile`
   request field; `select_runtime_image`, `DockerLaunchSettings`, the experimental launch flag, and
   dockerd supervision stay inside Modal. This refactor changes only the in-process control-plane
   provider boundary, not the Modal client request bodies, `web_api.py` parsing, or the
   `image_profile` columns — so control-plane, Modal, and web deploy independently.

## Consequences

### Positive

- Adding a provider, or flipping a capability (e.g. Daytona `supportsDocker`), is a table edit plus
  the provider's own realization — no edits to routes, web gating, or the lifecycle manager.
- The next runtime capability (e.g. GPU) extends `RequestedSandboxRuntime` and each provider's
  realization without reshaping the boundary.
- The environment id is shared and unifiable — the seed of a future cross-provider environment
  catalog (multiple named environments per provider).

### Negative

- The environment-id vocabulary is intentionally duplicated across shared TypeScript, Python
  (`settings.py`), and the D1 `CHECK` constraint. This is the shared contract, not an accidental
  leak; the definitions must be kept in sync.
- Carrying both `requestedRuntime` (intent) and `environment` (resolved id) is mildly redundant
  today (the latter is derived from the former), but it is the forward-compatible shape: intent
  drives provider behavior, the environment id drives image selection and snapshot compatibility.

## Follow-Up Rules

- New runtime capabilities are added to `RequestedSandboxRuntime` and realized per provider; never
  reshape the boundary for a single provider's mechanism.
- Gate behavior on `PROVIDER_CAPABILITIES`, never on the provider name (the provider factory is the
  one allowed `name → provider` site).
- Keep the environment-id type and `resolveEnvironment` in `@open-inspect/shared`; image realization
  (concrete `modal.Image` / snapshot) stays inside the provider.
- When a second provider gains a feature currently realized Modal-side (e.g. a dashboard URL), make
  the realization provider-aware (or move it onto the provider) rather than widening a
  Modal-specific helper behind a capability flag.

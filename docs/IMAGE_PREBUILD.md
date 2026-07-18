# Pre-Built Images

Pre-built images make your sessions start faster. Instead of cloning your repositories and
installing dependencies every time you create a session, Open-Inspect keeps a ready-to-go image
artifact that's refreshed automatically. New sessions start from that artifact and only need to pull
the latest commits — typically cutting startup from minutes to seconds.

One image-build subsystem serves two kinds of **build scope**:

- **A repository** — a one-repository set built on its default branch, enabled per-repo under
  **Settings > Images**.
- **An [environment](HOW_IT_WORKS.md#environments)** — an ordered set of up to 10 repositories,
  enabled per-environment under **Settings > Environments**.

Everything below applies to both scopes; the few places where they differ are called out.

---

## Why Use Pre-Built Images?

Every time you start a new session without pre-built images, the sandbox has to:

1. Clone your repositories from scratch
2. Install dependencies (`npm install`, `pip install`, etc.)
3. Run any setup commands you've configured

For large repositories with many dependencies, this can take anywhere from 30 seconds to several
minutes. With pre-built images, all of that work is done ahead of time. Your session starts from an
image artifact that already has the code and dependencies in place, and only needs to pull the last
few minutes of changes.

---

## Getting Started

Pre-built images are available when the deployment uses `sandbox_provider = "modal"`,
`sandbox_provider = "vercel"`, or `sandbox_provider = "opencomputer"`. The artifact is stored per
provider as a Modal image, Vercel snapshot, or OpenComputer checkpoint. Daytona deployments use
persistent sandboxes instead. E2B deployments use a provider base template plus persistent
pause/resume. Image settings are disabled for both backends; the E2B template is not a repository-
or environment-specific prebuilt image.

### Enable for a Repository

1. Open **Settings > Images** in the web dashboard
2. Find the repository you want to speed up
3. Toggle the switch to **enable** pre-built images

That's it. Enabling triggers the first build immediately, and images are then rebuilt automatically
every 30 minutes whenever new commits are pushed to the default branch. Your next session will use
the pre-built image automatically — no changes to your workflow needed.

### Enable for an Environment

1. Open **Settings > Environments** and create or edit an environment
2. Turn on the **prebuild** toggle
3. Saving the environment triggers the first build immediately; you can also click the rebuild
   button on the environment row at any time

### What You'll See in the UI

The Images settings page (and the environment rows under Settings > Environments) show the status of
each scope:

- **Ready** (green) — A pre-built image is available. Shows the git commit it was built from, how
  long ago it was built, and how long the build took.
- **Building** (amber, pulsing) — A build is currently in progress.
- **Failed** (red) — The last build failed. Shows the error message. The system will retry on the
  next scheduled run.
- **No image** — Image building is enabled but no build has completed yet.
- **Disabled** — Image building is turned off for this scope.

The new-session picker also annotates prebuild-enabled repositories and environments so a broken
prebuild is visible where you launch sessions, not just in settings. Each option carries one of four
states: "prebuilt" (a current-fingerprint image is ready), "prebuild building", "prebuild failed",
or "prebuilds on" (enabled, but no build has completed for the current fingerprint yet). Options
with prebuilds disabled are shown unannotated. A repository annotation reflects its default-branch
prebuild state and does not change with the picker's branch selector, since a repo image is only
built for the default branch.

---

## How It Works

### Image Identity

Every image records a **fingerprint** of the exact repository set it was built for — the ordered
list of repositories and their base branches (a repository scope is simply a one-element set on the
default branch). An image also records the commit SHA each repository was built at and the sandbox
runtime version it was built on. Spawn-time selection and the rebuild scheduler both key on this
identity, so editing a scope (changing an environment's repositories or a base branch) automatically
retires the old image.

### Automatic Rebuilds

A scheduler runs every 30 minutes and checks each prebuild-enabled scope. It triggers a rebuild when
any of the following holds:

- **No current image** — the scope was just enabled, its repository set or a base branch was edited
  (fingerprint mismatch), or the previous build failed
- **New commits** — any repository's branch tip has moved since the ready image was built
- **Outdated runtime** — the image was built on a sandbox runtime older than the current
  compatibility floor (such images are also skipped at spawn time)

The scheduler starts a bounded number of builds per tick across all scopes (`TRIGGER_CAP_PER_TICK`,
currently 8); anything beyond the cap is picked up on the next tick. Sessions fall back to the
normal startup flow while a scope waits for its build.

Builds also trigger immediately, outside the schedule, when:

- You **enable** prebuilds for a repository, or **save** a prebuild-enabled environment
- You **change an environment's secrets** — this additionally retires the existing ready image
  before the rebuild, so rotated values can't keep serving from an old image (see
  [Secrets Management](SECRETS.md#secrets-and-prebuilt-images))
- You click the **manual rebuild** button — next to the repository in Settings > Images, or on the
  environment row in Settings > Environments

Only one build runs per scope at a time; a trigger while a build is in flight is a no-op.

### What Happens During a Build

The build process runs the same setup steps that a normal session would:

1. Clones every repository in the scope at its base branch (for an environment, **sequentially, in
   position order**)
2. Runs each repository's `.openinspect/setup.sh` script (if present) in the same order
3. Saves a provider image artifact for the resulting environment

A failing setup script fails the whole build, and for environment builds the error names the
repository. Build-time secrets are exactly what the scope's sessions get: global + repository
secrets for a repository scope, global + environment secrets for an environment scope
([session-target scoping](SECRETS.md#which-secrets-a-session-receives)).

Everything your setup scripts install — dependencies, build artifacts, caches — is captured in the
image artifact. Depending on the active sandbox provider, this is stored as a Modal image, Vercel
snapshot, or OpenComputer checkpoint.

E2B's Terraform-built template contains the shared runtime and toolchain only. It does not produce
the per-repository or per-environment artifacts described in this guide.

### What Happens When You Start a Session

A session boots from the ready image when the image's fingerprint matches the session's own
repository snapshot (same repositories, same order, same base branches — for a single-repository
session that means the default branch):

1. The sandbox starts from the saved image artifact (code + dependencies already present)
2. A fast git sync pulls any commits pushed since the image was built (per repository)
3. The coding agent starts immediately

Your setup scripts are **not** re-run since they already ran during the build. This is the main
source of time savings.

If no matching ready image is available (disabled, first build hasn't finished, the last build
failed, a non-default branch was selected, or the environment was edited after the session was
created), the session falls back to the normal startup flow automatically. If the saved artifact
itself fails to restore, the image is marked failed and the session retries from the base image.
Either way, you'll never be blocked from starting a session.

**Ad-hoc multi-repository sessions never use prebuilt images.** Picking "Multiple repositories" in
the new-session picker always does a full clone + setup for each repository. If you use the same set
regularly, save it as an environment and enable prebuilds.

---

## Optimizing Your Setup Script

The more work you front-load into your `.openinspect/setup.sh`, the faster your sessions start. Here
are some tips:

- **Install all dependencies** — `npm install`, `pip install -r requirements.txt`, `bundle install`,
  etc.
- **Run build steps** — `npm run build`, `cargo build`, code generation, compiled assets
- **Warm caches** — Running your test suite once during setup means cached files are available for
  subsequent runs in the session
- **Pre-download large resources** — Models, datasets, or any large files the agent might need

Don't worry about build duration. Builds run in the background and users always get the last
_successfully_ built image. A 10-minute build is worthwhile if it saves 10 minutes on every session
start.

---

## Troubleshooting

### Build keeps failing

Check the error message shown next to the failed build — on **Settings > Images** for repository
scopes, or on the environment's row in **Settings > Environments**. Common causes:

- **Setup script errors** — A `.openinspect/setup.sh` is failing. Test it locally or check the
  script for commands that might not work in the sandbox environment (Debian Linux with Node.js,
  Python, and common dev tools). For environment builds, the error names which repository's script
  failed.
- **Timeout** — Builds have a 30-minute limit by default. If your setup takes longer, look for ways
  to optimize it (e.g., use faster package managers, reduce dependencies). Environment builds run
  one setup script per repository, so large environments approach the limit sooner. The timeout is
  the scope's resolved build-timeout setting: global defaults, overridden by the primary
  repository's settings and — for environments — the environment's own overrides.

The system automatically retries on the next scheduled run, so transient failures (network issues,
temporary service outages) resolve themselves.

### Session isn't using the pre-built image

For a **repository** session, verify that:

- Image building is **enabled** for the repository in Settings > Images
- The status shows **Ready** (not Building or Failed)
- You're creating a session for the same repository, on its **default branch** — images are built
  for the default branch, so a session on another branch falls back to the normal startup flow

For an **environment** session, verify that:

- The **prebuild** toggle is on for the environment in Settings > Environments
- The environment's image status shows **Ready**
- The environment hasn't been edited (repositories, order, or base branches) since the image was
  built — an edit retires the image until the rebuild completes
- You launched the session by picking the **environment** in the picker — ad-hoc "Multiple
  repositories" selections never use prebuilt images, even if an environment with the same
  repositories exists

### Image seems stale

Pre-built images are rebuilt every 30 minutes when new commits are detected. If you just pushed code
and want the image updated immediately, trigger a manual rebuild — the refresh button next to the
repository in Settings > Images, or next to the environment in Settings > Environments.

---

## Disabling Pre-Built Images

To stop using pre-built images, toggle the switch off — per repository in Settings > Images, or the
prebuild toggle on the environment in Settings > Environments. New sessions will return to the
normal startup flow (full clone + setup). Existing sessions are not affected.

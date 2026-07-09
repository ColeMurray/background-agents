# Pre-Built Images

Pre-built images make your sessions start faster. Instead of cloning your repository and installing
dependencies every time you create a session, Open-Inspect keeps a ready-to-go image artifact that's
refreshed automatically. New sessions start from that artifact and only need to pull the latest
commits — typically cutting startup from minutes to seconds.

Images come in two flavors:

- **Repository images** — one repository, enabled per-repo under **Settings > Images**.
- **Environment images** — a prebuilt of an entire [environment](HOW_IT_WORKS.md#environments) (an
  ordered set of up to 10 repositories), enabled per-environment under **Settings > Environments**.
  See [Environment Images](#environment-images) below.

---

## Why Use Pre-Built Images?

Every time you start a new session without pre-built images, the sandbox has to:

1. Clone your repository from scratch
2. Install dependencies (`npm install`, `pip install`, etc.)
3. Run any setup commands you've configured

For large repositories with many dependencies, this can take anywhere from 30 seconds to several
minutes. With pre-built images, all of that work is done ahead of time. Your session starts from a
repo image artifact that already has the code and dependencies in place, and only needs to pull the
last few minutes of changes.

---

## Getting Started

Pre-built images (repository and environment) are available when the deployment uses
`sandbox_provider = "modal"`, `sandbox_provider = "vercel"`, or `sandbox_provider = "opencomputer"`.
The artifact is stored per provider as a Modal image, Vercel snapshot, or OpenComputer checkpoint.
Daytona deployments use persistent sandboxes instead, so the image settings are disabled for that
backend.

### Enable for a Repository

1. Open **Settings > Images** in the web dashboard
2. Find the repository you want to speed up
3. Toggle the switch to **enable** pre-built images
4. Optionally click the refresh button to trigger the first build immediately

That's it. Once enabled, images are rebuilt automatically every 30 minutes whenever new commits are
pushed to the default branch. Your next session will use the pre-built image automatically — no
changes to your workflow needed.

### What You'll See in the UI

The Images settings page shows the status of each repository:

- **Ready** (green) — A pre-built image is available. Shows the git commit it was built from, how
  long ago it was built, and how long the build took.
- **Building** (amber, pulsing) — A build is currently in progress.
- **Failed** (red) — The last build failed. Shows the error message. The system will retry on the
  next scheduled run.
- **No image** — Image building is enabled but no build has completed yet.
- **Disabled** — Image building is turned off for this repository.

---

## How It Works

### Automatic Rebuilds

A scheduler runs every 30 minutes and checks each enabled repository:

1. Compares the latest commit on your default branch with the commit the current image was built
   from
2. If there are new commits, triggers a fresh build
3. If nothing has changed, skips the rebuild

This means your pre-built image is never more than ~30 minutes behind your latest code.

### What Happens During a Build

The build process runs the same setup steps that a normal session would:

1. Clones your repository
2. Runs your `.openinspect/setup.sh` script (if you have one)
3. Saves a provider image artifact for the resulting environment

Everything your setup script installs — dependencies, build artifacts, caches — is captured in the
image artifact. Depending on the active sandbox provider, this is stored as a Modal image, Vercel
snapshot, or OpenComputer checkpoint.

### What Happens When You Start a Session

When you create a new session for a repository with a pre-built image:

1. The sandbox starts from the saved image artifact (code + dependencies already present)
2. A fast git sync pulls any commits pushed since the image was built
3. The coding agent starts immediately

Your setup script is **not** re-run since it already ran during the build. This is the main source
of time savings.

If no pre-built image is available (disabled, first build hasn't finished, or the last build
failed), the session falls back to the normal startup flow automatically. You'll never be blocked
from starting a session.

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

## Environment Images

An [environment](HOW_IT_WORKS.md#environments) can be prebuilt as a unit, so sessions launched from
it start with **all** of its repositories cloned and set up.

### Enabling

1. Open **Settings > Environments** and create or edit an environment
2. Turn on the **prebuild** toggle
3. Saving the environment triggers the first build immediately; you can also click the rebuild
   button on the environment row at any time

The environments list shows the same status indicators as repository images (Ready / Building /
Failed with the error message), and the new-session picker annotates prebuild-enabled environments
with "prebuilt" or "prebuild building".

### How environment builds work

A build clones every repository in the environment at its configured base branch and runs each
repository's `.openinspect/setup.sh` **sequentially, in position order**. A failing setup script
fails the whole build, and the error names the repository. Build-time secrets are exactly what the
environment's sessions get: global + environment secrets
([launch-unit scoping](SECRETS.md#which-secrets-a-session-receives)).

### When environment images rebuild

The same 30-minute scheduler that refreshes repository images checks each prebuild-enabled
environment and rebuilds when any of the following holds:

- **No current image** — the environment was just created, its repository set or a base branch was
  edited, or the previous build failed
- **New commits** — any repository's base branch has moved since the ready image was built
- **Outdated runtime** — the image was built on a sandbox runtime older than the current
  compatibility floor

In addition, **changing the environment's secrets immediately retires the existing ready image and
triggers a rebuild**, so rotated values can't keep serving from an old image. The scheduler starts a
bounded number of environment builds per tick; anything beyond the cap is picked up on the next
tick.

### What sessions get

A session launched from the environment boots from the ready image when the image matches the
session's own repository snapshot (same repositories, same order, same base branches) — setup
scripts are skipped and each repository just syncs to its latest commits. If there's no matching
ready image (still building, failed, or the environment was edited after the session was created),
the session falls back to the normal startup flow — you're never blocked on a build.

**Ad-hoc multi-repository sessions never use prebuilt images.** Picking "Multiple repositories" in
the new-session picker always does a full clone + setup for each repository. If you use the same set
regularly, save it as an environment and enable prebuilds.

---

## Troubleshooting

### Build keeps failing

Check the error message shown next to the failed build — on **Settings > Images** for repository
images, or on the environment's row in **Settings > Environments** for environment images. Common
causes:

- **Setup script errors** — A `.openinspect/setup.sh` is failing. Test it locally or check the
  script for commands that might not work in the sandbox environment (Debian Linux with Node.js,
  Python, and common dev tools). For environment builds, the error names which repository's script
  failed.
- **Timeout** — Builds have a 30-minute limit. If your setup takes longer, look for ways to optimize
  it (e.g., use faster package managers, reduce dependencies). Environment builds run one setup
  script per repository, so large environments approach the limit sooner; the timeout for an
  environment build comes from the **primary** (first) repository's build-timeout setting.

The system automatically retries on the next scheduled run, so transient failures (network issues,
temporary service outages) resolve themselves.

### Session isn't using the pre-built image

For a **repository** session, verify that:

- Image building is **enabled** for the repository in Settings > Images
- The status shows **Ready** (not Building or Failed)
- You're creating a session for the same repository that the image was built for

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

# Pre-Built Images

Pre-built images make your sessions start faster. Instead of cloning your repository and installing
dependencies every time you create a session, Open-Inspect keeps a ready-to-go snapshot of your repo
that's refreshed automatically. New sessions start from this snapshot and only need to pull the
latest commits — typically cutting startup from minutes to seconds.

---

## Why Use Pre-Built Images?

Every time you start a new session without pre-built images, the sandbox has to:

1. Clone your repository from scratch
2. Install dependencies (`npm install`, `pip install`, etc.)
3. Run any setup commands you've configured

For large repositories with many dependencies, this can take anywhere from 30 seconds to several
minutes. With pre-built images, all of that work is done ahead of time. Your session starts from a
snapshot that already has the code and dependencies in place, and only needs to pull the last few
minutes of changes.

---

## Getting Started

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
3. Saves a snapshot of the resulting environment

Everything your setup script installs — dependencies, build artifacts, caches — is captured in the
snapshot.

### What Happens When You Start a Session

When you create a new session for a repository with a pre-built image:

1. The sandbox starts from the saved snapshot (code + dependencies already present)
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

## Troubleshooting

### Build keeps failing

Check the error message shown in the Images settings page. Common causes:

- **Setup script errors** — Your `.openinspect/setup.sh` is failing. Test it locally or check the
  script for commands that might not work in the sandbox environment (Debian Linux with Node.js,
  Python, and common dev tools).
- **Timeout** — Builds have a 30-minute limit. If your setup takes longer, look for ways to optimize
  it (e.g., use faster package managers, reduce dependencies).

The system automatically retries on the next scheduled run, so transient failures (network issues,
temporary service outages) resolve themselves.

### Session isn't using the pre-built image

Verify that:

- Image building is **enabled** for the repository in Settings > Images
- The status shows **Ready** (not Building or Failed)
- You're creating a session for the same repository that the image was built for

### Image seems stale

Pre-built images are rebuilt every 30 minutes when new commits are detected. If you just pushed code
and want the image updated immediately, click the refresh button next to the repository in the
Images settings page to trigger a manual rebuild.

---

## Disabling Pre-Built Images

To stop using pre-built images for a repository, toggle the switch off in Settings > Images. New
sessions will return to the normal startup flow (full clone + setup). Existing sessions are not
affected.

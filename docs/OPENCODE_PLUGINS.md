# Workspace OpenCode plugins

In **Settings → OpenCode plugins**, administrators can add a pinned npm package such as
`@company/audit@1.2.3`, enable or disable it, and apply it globally or to selected repositories. A
scoped plugin applies when any session repository matches, including secondary repositories and
nested owners. Repository-less sessions receive global plugins. The catalog is resolved again on
fresh and snapshot-restored sandbox boots. Running sessions pick up edits on their next boot, not
immediately.

Viewing the catalog requires `opencode_plugins.read`; mutations require `opencode_plugins.manage`.
Owners and Administrators can manage plugins by default, while Members and Viewers can read the
catalog. Full editor saves require the revision read by the editor and reject stale edits with HTTP
409; switches update only `enabled` and advance the revision. Managers can enter repository names
directly without repository-read permission. Only the OpenCode harness consumes this configuration;
Claude and native Codex ignore it.

Plugins are trusted executable code. They receive the session's credentials and network access. Only
install packages you trust. Use the existing global, repository, environment, or team secrets for
configuration and credentials; credentials are not stored in the plugin catalog. Private registries
require working npm authentication in the sandbox.

## Startup and failure handling

The runtime preinstalls each package into the pinned OpenCode loader's npm cache before initializing
OpenCode, retaining the original npm spec in the generated `plugin` array. Exact versions and
completed-install markers allow reuse across snapshot restores. Lifecycle install scripts are
disabled, matching OpenCode's npm installer. Existing repository plugin configuration still loads
through OpenCode's normal configuration merge.

Installation is bounded by `PLUGIN_INSTALL_TIMEOUT_SECONDS` per plugin and
`PLUGIN_INSTALL_BUDGET_SECONDS` across the selection. Invalid packages and failed or timed-out
installs are omitted. The runtime initializes the plugin registry without a model request; OpenCode
skips ordinary import, compatibility and initialization errors. A managed plugin that prevents
OpenCode from initializing within `PLUGIN_INITIALIZATION_TIMEOUT_SECONDS` triggers one restart with
the entire managed selection omitted. Per-repository plugins are outside this fallback.

Skipped plugins produce session warnings. The session sidebar shows the latest boot's managed plugin
list and its loading, loaded, or skipped status. The supervisor event channel remains live after
readiness; reconnecting bridges replay the latest plugin snapshot. The control plane persists that
report separately from conversation history and clears it when reserving a new sandbox boot.
“Loaded” means the registry initialized without a reported load error, not that all of a plugin's
later hooks will succeed. Arbitrary plugin code can crash or block the process after startup; this
is not a security or process isolation boundary.

## Deployment and limits

Apply D1 migrations through `0090_opencode_plugin_revisions.sql`, deploy the control plane and web,
and rebuild sandbox images with the updated runtime. A matching plugin selection requires at least
`minimumOpencodePluginsGeneration` from the runtime manifest. Older prebuilds are skipped in favor
of the current base image. Restoring an older snapshot with matching plugins is held without
replacing its saved state; disable the matching plugins or recover it using an upgraded runtime.
Sessions without matching plugins keep their existing compatibility floor. Existing prebuilds are
not invalidated by catalog edits; plugins install during boot and reuse completed cached
installations where available. Image-prebuild installation is not part of this change. Direct
versions are pinned; transitive dependencies follow npm's resolution and the cached lockfile, so
independently rebuilt caches need not be bit-for-bit identical.

The cache layout and load-error reporting are coupled to OpenCode 1.18.29 and covered by a
real-binary test with synthetic local packages. Re-run that contract test when updating OpenCode. No
live third-party plugin, private registry, observability backend, or paid model call is required by
these tests.

# Enforced investigation profile

This adapts HomeLab Operator's separation of credentials, fixed execution permissions and runtime
filesystem controls to the existing OpenInspect harness. It does not replace the agent model loop.

## Contract

`executionProfile: "investigation"` is selected when a session is created and persists in the
session Durable Object. Reinitialization cannot relax it. Linear `LINEAR_TASK_MODE=read-only`
requests this profile for new sessions and requires it on subsequent prompts; an older unrestricted
session rejects those prompts rather than silently changing its label.

The first supported combination is one repository, Modal, OpenCode and an OpenRouter API key. The
catalog includes the pilot's `openrouter/deepseek/deepseek-v4.1-flash` route as an opt-in model.
The investigation config explicitly defines this route for pinned OpenCode because its bundled
catalog predates the model and catalog fetching stays disabled. See the
[DIV-81 diagnosis and offline regression](investigation-model-resolution-2026-09-16.md).
Creation rejects zero or multiple resolved repositories before persisting the session; both scalar
repository fields and a one-entry repository list are accepted. Environment sessions, other
harnesses/providers, repository images and snapshot restores are not supported. They fail closed.
Repository secrets, MCP servers, managed skills, repository setup/start scripts, custom tools,
desktop/editor/terminal services and exposed ports are excluded. Child-session admission is denied,
independently of the model's native `task` tool being denied.

The OpenCode process runs inside bubblewrap user/PID/mount/IPC/UTS namespaces with capabilities
dropped. The checkout and installed binaries are read-only; the remaining root filesystem is
read-only. `/scratch` and `/tmp` are disposable writable filesystems. Git metadata, project
configuration and extension directories are hidden. The process receives a minimal environment: the
OpenRouter model key is present, but control-plane authentication, SCM credentials, repository
secrets and ambient process settings are not inherited. The supervisor retains the credentials it
needs for initial checkout and event transport outside this process boundary.

OpenCode denies all tools except source reads, glob and grep. Reads outside `/workspace` and
external directory access are denied. Shell commands, file edits, native delegation, web tools and
dynamic extensions are unavailable. Tests requiring command execution need a different, explicitly
authorized profile; allowing general shell commands is not part of this increment.
Read permissions use the pinned harness's worktree-relative paths. Search requires image-installed
ripgrep; it must not depend on a runtime download. Checkout admission rejects external, dangling,
cyclic and directory symlinks because the harness's directory checks are lexical; internal
regular-file links remain supported. See the [DIV-85 tool regression](investigation-source-tools-2026-09-16.md).

Modal egress admits only HTTPS to the configured control-plane hostname, `openrouter.ai`, and
`github.com` (initial checkout). An empty CIDR allowlist rejects raw-IP/non-TLS access. This is not
a fixture-only or fully disconnected sandbox: authorized model/control-plane traffic still exists,
and a hostname allowlist is not a URL/method-level authorization policy.

## Release

Requires Modal SDK 1.5.5 and runtime generation 66 with bubblewrap installed. Build shared first;
release compatible control-plane and Linear code, rebuild and deploy the Modal base image/runtime,
and only then enable Linear read-only tasks. Do not pair new task routing with an older runtime. No
live agent pilot or service deployment is performed by this implementation. Existing publication
settings remain unchanged. This profile does not add a hard dollar cap or automatic task scheduling.

## Verification

The opt-in real namespace test attempts modifications to an existing repository file, creation of a
new file, a write outside scratch and a symlink escape to a supervisor file. It verifies denial,
hidden Git/plugin data and successful scratch writes. It must pass on a host supporting namespaces:

```sh
OPENINSPECT_TEST_NAMESPACES=1 packages/sandbox-runtime/.venv/bin/pytest \
  packages/sandbox-runtime/tests/test_investigation.py -q
```

On 2026-09-16, that test passed locally. A separate credential-free Modal sandbox
`sb-0cnjxRaVboyhN8Wm5aU5Li` successfully ran a nested namespace probe (exit 0), with all outbound
network blocked, a 60-second lifetime and explicit termination. This establishes namespace
availability, not the complete production launch path.

The exact pinned OpenCode 1.18.29 also resolved its configuration inside the filesystem boundary
with network disabled, a dummy API key and a hostile project config: deny-by-default permissions
were retained, plugins were empty, MCP was absent and only OpenRouter was enabled. No model call was
made. Unit tests cover stripped credentials, unsupported profiles, missing isolation tooling,
provider admission and follow-up profile mismatch.

A separate credential-free Modal network probe (`sb-05NSn4Q41R1tINIe4XfLSO`, 45-second lifetime)
returned HTTP 200 from its allowlisted domain and connection errors for a different domain and
raw-IP HTTP. It exited 0 and was explicitly terminated. No model or repository was involved.

The runtime regression suite passed 1,045 tests with three skips using a temporary pytest fixture
that redirected the existing host Git configuration and GitHub-wrapper writes to test directories.
The unmodified suite attempts `/usr/local/bin/gh` writes on hosts with GitHub CLI installed; it
failed there before the isolated run. The focused Modal suite passed 106 tests.

Before claiming a successful live enforced investigation, rebuild the image and check the complete
agent launch in a bounded dev test. Missing bubblewrap, unavailable namespaces, unsupported
configuration or an unsupported SDK must never cause an unrestricted fallback.

The [DIV-77 dev pilot](investigation-profile-pilot-2026-09-16.md) deployed generation 66 on an
explicitly authorized release retry. Its single smoke passed independent filesystem boundary probes
but failed to resolve the approved model before source reads or a report. A complete enforced live
investigation remains unproven; [DIV-81](https://linear.app/divinedesign/issue/DIV-81) tracks the
blocker.

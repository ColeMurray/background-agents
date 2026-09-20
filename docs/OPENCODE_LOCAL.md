# Running OpenCode Locally on This Repo

[OpenCode](https://opencode.ai) is the built-in harness Open-Inspect runs inside sandboxes, but it
is also a normal CLI you can run on a checkout of this repository to work on it. This page covers
that local use: installing a matching version, pointing it at the repo, and the ways a local run
differs from a sandbox session.

For the harness as a product feature (choosing a harness for a session, provider accounts,
subscriptions), see [CLAUDE_AGENT.md](CLAUDE_AGENT.md) and
[HOW_IT_WORKS.md](HOW_IT_WORKS.md#the-agent).

---

## Install

OpenCode needs Node `>=22.13.0`, the same floor as the repo (`package.json` `engines`).

```bash
npm install -g opencode-ai            # or: curl -fsSL https://opencode.ai/install | bash
opencode --version
```

The sandbox image pins its OpenCode version in
[`packages/sandbox-images/toolchain.json`](../packages/sandbox-images/toolchain.json):

| Field             | Meaning                                                                   |
| ----------------- | ------------------------------------------------------------------------- |
| `opencode`        | The version baked into sandbox images — match this to reproduce a session |
| `opencodeMinimum` | The floor `validate_toolchain` enforces at image-build time (`bundle.py`) |

Match the pinned version when you are debugging harness behaviour rather than writing ordinary code:

```bash
opencode upgrade 1.18.29        # use the value from toolchain.json
```

## First run

```bash
cd background-agents
opencode                                  # TUI in the repo root
opencode run "summarise the D1 schema"    # headless, prints to stdout
opencode run --agent plan "how do sessions resume after a snapshot restore?"
```

Credentials live outside the repo in `~/.local/share/opencode/auth.json`:

```bash
opencode auth list
opencode auth login        # pick a provider, paste a key or complete OAuth
```

OpenCode Zen's free models answer with no credentials configured at all, so `opencode run` works on
a fresh machine — it just picks a free model rather than the one you want. For real work on this
repo, log in and select a model explicitly:

```bash
opencode run -m anthropic/claude-sonnet-4-6 "..."   # the catalog default in packages/shared/src/models.ts
opencode models                                      # everything your credentials can reach
```

### OpenCode Go

[OpenCode Go](https://opencode.ai/docs/go/) is a flat-rate subscription on top of an OpenCode Zen
key. Subscribe at `https://opencode.ai/auth`, then either paste the key into the TUI with `/connect`
(choose **OpenCode Go**) or export it — one variable covers both gateways, because the `opencode`
and `opencode-go` providers share the `OPENCODE_API_KEY` env var:

```bash
export OPENCODE_API_KEY=...
opencode run -m opencode-go/kimi-k3 "..."
```

Sandbox sessions use the same key, supplied as a secret rather than an env var — see
[AVAILABLE_MODELS.md](AVAILABLE_MODELS.md#opencode-go).

## What OpenCode picks up from the repo

- **`AGENTS.md`** at the repo root is loaded automatically. `CLAUDE.md` is a symlink to it, so both
  harnesses read one file — edit `AGENTS.md`.
- **No committed `.opencode/` or `opencode.json`.** There is nothing repo-specific to load, and
  nothing to keep in sync.
- If you add local config (`opencode.json`, `.opencode/`), note that neither path is in `.gitignore`
  — the sandbox keeps its generated `.opencode/` out of `git status` with a runtime git exclude, not
  with `.gitignore`. For a local-only config, do the same:

  ```bash
  echo ".opencode/" >> .git/info/exclude
  ```

## The verification loop

OpenCode has no special access here — point it at the same commands `AGENTS.md` documents, and build
`@open-inspect/shared` first whenever shared types change:

```bash
npm run build -w @open-inspect/shared
npm run typecheck
npm run lint:fix
npm test -w @open-inspect/control-plane
```

## Working on the OpenCode harness itself

The harness code lives in `packages/sandbox-runtime/src/sandbox_runtime/` (`opencode_server.py`
launches the server; `harness/opencode*.py` drive it over HTTP/SSE). Its tests run with `uv` from
the package directory:

```bash
cd packages/sandbox-runtime
uv run --frozen --extra dev pytest tests/ -v
uv run --frozen --extra dev pytest tests/test_opencode_client.py -q
```

## How a local run differs from a sandbox session

Same binary, different configuration. The sandbox setup is assembled in `opencode_server.py`; a
local run uses your own files and defaults instead.

| Aspect      | Local run                               | Sandbox session                                                                  |
| ----------- | --------------------------------------- | -------------------------------------------------------------------------------- |
| Config      | `opencode.json` / `~/.config/opencode/` | Generated and passed as `OPENCODE_CONFIG_CONTENT`                                |
| Permissions | OpenCode's defaults; `--auto` is opt-in | `{"*": {"*": "allow"}}` — the sandbox is the containment boundary                |
| Interaction | TUI can ask you questions               | `OPENCODE_CLIENT=serve` disables the question tool (nothing can answer)          |
| Tools       | Whatever you install                    | `.opencode/tool/*.js` (PR creation, child sessions, Slack notify) staged at boot |
| Skills      | Whatever you install                    | Bundled skills copied into `.opencode/skills/`                                   |
| MCP         | Your own config                         | Injected from session config, packages installed at boot                         |
| Model       | `-m` or your default                    | Chosen per session by the control plane                                          |
| Working dir | Wherever you start it                   | The repo for single-repo sessions, `/workspace` for multi-repo                   |

A consequence worth remembering: a prompt that works locally in the TUI can hang in a session if it
relies on the agent asking a clarifying question. That path is deliberately closed in the sandbox.

## Other entry points

```bash
opencode serve --port 4096      # headless server (what the sandbox supervisor runs)
opencode attach <url>           # attach a TUI to a running server
opencode pr <number>            # check out a GitHub PR branch, then start
```

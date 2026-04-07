# Claude OAuth Setup

Open-Inspect uses Claude OAuth for agent authentication instead of API keys. OAuth tokens are stored
on a Modal Volume and mounted into sandboxes at `/root/.claude`.

## Prerequisites

- Claude Code CLI installed and authenticated locally
- Modal CLI configured (`modal token set`)
- Python 3.12+ with `modal` package installed

## Setup

### 1. Authenticate with Claude Code

```bash
claude auth login
```

This creates `~/.claude/.credentials.json` with your OAuth tokens.

### 2. Upload credentials to Modal Volume

```bash
python scripts/setup_claude_oauth.py
```

This reads credentials from `~/.claude/.credentials.json` and uploads them to the `claude-auth-vol`
Modal Volume.

### 3. Verify

```bash
modal volume ls claude-auth-vol
```

You should see `.credentials.json` in the volume listing.

## How It Works

1. The Modal Volume `claude-auth-vol` is mounted at `/root/.claude` in every sandbox (configured in
   `packages/modal-infra/src/sandbox/manager.py`)
2. Claude Code reads OAuth tokens from `/root/.claude/.credentials.json`
3. Token refresh is handled automatically by Claude Code
4. No API keys needed — uses your Claude Pro/Team/Enterprise subscription

## Troubleshooting

### "Missing credentials" error in sandbox logs

Re-run the setup script:

```bash
python scripts/setup_claude_oauth.py
```

### Token expired

Claude Code handles token refresh automatically. If tokens are fully expired, re-authenticate
locally and re-run the setup script:

```bash
claude auth login
python scripts/setup_claude_oauth.py
```

## Migration from API Keys

If you previously used `ANTHROPIC_API_KEY` via the `llm-api-keys` Modal Secret, that secret is no
longer needed. You can delete it:

```bash
modal secret delete llm-api-keys
```

# Skyward fork of Open-Inspect

`skyward` is our default branch. `main` mirrors `ColeMurray/background-agents` and never gets our commits.

## Remotes

- `origin`: `Skyward-AI/background-agents` (ours)
- `upstream`: `ColeMurray/background-agents` (fetch only; its push URL is `NO_PUSH_TO_UPSTREAM`)

Set up a fresh clone:

```bash
git remote add upstream https://github.com/ColeMurray/background-agents.git
git remote set-url --push upstream NO_PUSH_TO_UPSTREAM
gh repo set-default Skyward-AI/background-agents
git config rerere.enabled true
git config rerere.autoupdate true
```

## Pull upstream changes

```bash
git fetch upstream
git checkout main && git merge --ff-only upstream/main && git push origin main
git checkout skyward && git rebase main
git push --force-with-lease origin skyward
```

## Pull requests

Open them against `Skyward-AI/background-agents` base `skyward`. `gh pr create` does this by default. In the GitHub web UI, check the base repository dropdown: GitHub often preselects the upstream repo for forks.

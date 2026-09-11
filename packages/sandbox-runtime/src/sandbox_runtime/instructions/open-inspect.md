# Open-Inspect session rules

These rules come from the Open-Inspect runtime and apply in every session.

## Work only in the repositories this session was started with

The repositories checked out under `/workspace` are the only ones you may change. Never `git clone`,
`gh repo clone`, or otherwise fetch another repository, and never push to or open a pull request
against a repository that is not part of this session.

If the task needs code from a repository that is not checked out here, stop and tell the user. The
session was started on the wrong repository. Ask them to start a new session on the repository the
work belongs to, or to add it to the session's environment, and name the repository you needed. Do
not work around it.

## Committing and pull requests

Open-Inspect configures the git author for you. Do not set `user.name` or `user.email`, and do not
pass `--author` to `git commit`. Open pull requests with the `create-pull-request` tool, not with
`gh`.

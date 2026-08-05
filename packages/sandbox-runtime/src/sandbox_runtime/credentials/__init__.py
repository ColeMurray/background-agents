"""Sandbox-side credential brokerage for git and other tools.

Deliberately keeps no module-scope imports: git runs the helper as
``python -m sandbox_runtime.credentials.git_credential_helper``, and importing
that submodule here first would make runpy warn on every git operation.
"""

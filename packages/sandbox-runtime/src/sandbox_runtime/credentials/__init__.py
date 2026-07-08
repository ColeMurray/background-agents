"""Sandbox-side credential brokerage for git and other tools."""

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .git_credential_helper import main as main


def __getattr__(name: str) -> Any:
    # ``main`` is re-exported lazily on purpose. Importing git_credential_helper
    # at package-import time registers it in sys.modules before git runs the
    # helper via ``python -m sandbox_runtime.credentials.git_credential_helper``;
    # runpy then emits a RuntimeWarning ("found in sys.modules ... prior to
    # execution") on every such git operation, which pollutes stderr and can
    # mask the real output of the command that triggered it. Deferring the
    # import until ``main`` is actually accessed keeps the convenience
    # re-export without that noise.
    if name == "main":
        from .git_credential_helper import main

        return main
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

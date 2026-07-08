"""Sandbox-side credential brokerage for git and other tools.

Deliberately imports nothing at module scope. git invokes the credential helper
as ``python -m sandbox_runtime.credentials.git_credential_helper``; if this
package eagerly imported that submodule (e.g. a ``from .git_credential_helper
import main`` convenience re-export), the submodule would already be in
``sys.modules`` when runpy executes it as ``__main__`` — making runpy emit a
RuntimeWarning ("found in sys.modules ... prior to execution") on every git
operation, which pollutes stderr and can mask the real output of the command
that triggered it. Import ``main`` from the submodule directly if you need it.
"""

"""Re-export structured logging from sandbox-shared, configured for daytona-infra."""

from sandbox_shared.sandbox.log_config import (  # noqa: F401
    JSONFormatter,
    StructuredLogger,
    configure_logging,
    get_logger,
    set_default_service,
)

# Set the default service name for this package
set_default_service("daytona-infra")

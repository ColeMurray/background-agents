"""CLI entrypoint for seeding the repo-local Daytona base snapshot."""

from __future__ import annotations

import argparse
import time

from daytona import Daytona, DaytonaConfig, DaytonaNotFoundError

from .config import load_config
from .toolchain import create_base_snapshot

# Daytona's snapshot.delete() returns before the backend has finished removing
# the snapshot. Recreating with the same name inside that window fails with
# "Snapshot already exists", so we poll until the delete is fully visible
# before rebuilding.
_SNAPSHOT_DELETE_TIMEOUT_SECONDS = 300
_SNAPSHOT_DELETE_POLL_SECONDS = 5


def _wait_for_snapshot_deletion(client: Daytona, name: str) -> None:
    """Block until the named snapshot is no longer returned by the API."""
    deadline = time.monotonic() + _SNAPSHOT_DELETE_TIMEOUT_SECONDS
    while True:
        try:
            client.snapshot.get(name)
        except DaytonaNotFoundError:
            return
        if time.monotonic() >= deadline:
            raise TimeoutError(
                f"Daytona snapshot {name!r} still present "
                f"{_SNAPSHOT_DELETE_TIMEOUT_SECONDS}s after delete()"
            )
        print(f"Waiting for snapshot {name!r} deletion to complete...")
        time.sleep(_SNAPSHOT_DELETE_POLL_SECONDS)


def main() -> None:
    """Create or recreate the configured Daytona base snapshot."""
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--force",
        action="store_true",
        help="Delete the existing named snapshot before rebuilding it.",
    )
    args = parser.parse_args()

    config = load_config()
    client = Daytona(
        DaytonaConfig(
            api_key=config.api_key,
            api_url=config.api_url,
            target=config.target,
        )
    )

    if args.force:
        try:
            existing = client.snapshot.get(config.base_snapshot)
        except DaytonaNotFoundError:
            existing = None

        if existing is not None:
            client.snapshot.delete(existing)
            _wait_for_snapshot_deletion(client, config.base_snapshot)

    create_base_snapshot(client, config.repo_root, config.base_snapshot)


if __name__ == "__main__":
    main()

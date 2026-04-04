"""CLI entrypoint for seeding the repo-local Daytona base snapshot."""

from __future__ import annotations

import argparse

from daytona import Daytona, DaytonaConfig, DaytonaNotFoundError

from .config import load_config
from .toolchain import create_base_snapshot


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

    create_base_snapshot(client, config.repo_root, config.base_snapshot)


if __name__ == "__main__":
    main()

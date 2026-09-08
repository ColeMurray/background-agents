from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any

from .constants import BOOT_WARNINGS_FILE_PATH

if TYPE_CHECKING:
    from .repo_config import RepoEntry


class BootWarningSink:
    """Persist boot warnings for the agent bridge to forward after connecting."""

    def __init__(self, log: Any) -> None:
        self.log = log

    def record(self, scope: str, message: str, repo: RepoEntry | None = None) -> None:
        entry: dict[str, str] = {"scope": scope, "message": message}
        if repo is not None:
            entry["repoOwner"] = repo.owner
            entry["repoName"] = repo.name
        self.log.warn(
            "supervisor.boot_warning",
            scope=scope,
            warning_message=message,
            repo_owner=repo.owner if repo is not None else None,
            repo_name=repo.name if repo is not None else None,
        )
        try:
            with open(BOOT_WARNINGS_FILE_PATH, "a") as warnings_file:
                warnings_file.write(json.dumps(entry) + "\n")
        except Exception as error:
            self.log.warn("supervisor.boot_warning_write_failed", exc=error)

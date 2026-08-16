"""Fetch, validate, and install control-plane-managed OpenCode skills."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import shutil
import uuid
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING, Any
from urllib.parse import quote

import httpx

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping, Sequence

    from .repo_config import RepoEntry

MAX_SKILL_NAME_LENGTH = 64
MAX_SKILL_FILES = 100
MAX_SKILL_FILE_BYTES = 256 * 1024
MAX_SKILL_REVISION_BYTES = 1024 * 1024
MAX_SKILL_PATH_BYTES = 240
MAX_SKILL_PATH_DEPTH = 10
MAX_MANAGED_SKILLS_PER_SESSION = 20
MAX_MANAGED_SKILL_MANIFEST_BYTES = 5 * 1024 * 1024
MAX_MANAGED_SKILL_RESPONSE_BYTES = 32 * 1024 * 1024
MANAGED_SKILLS_FETCH_TIMEOUT_SECONDS = 15.0
MANAGED_SKILLS_REQUEST_ATTEMPTS = 3
MANAGED_SKILLS_RETRY_BASE_SECONDS = 0.25

_SKILL_NAME_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_YAML_NAME_RE = re.compile(
    r"""^\s*(?:name|"name"|'name')\s*:\s*(?:"([^"]+)"|'([^']+)'|([^#\s]+))"""
)
_DISCOVERY_PATHS = (".opencode/skills", ".claude/skills", ".agents/skills")


class ManagedSkillsError(RuntimeError):
    """A managed-skill startup failure with a stable error code."""

    def __init__(self, message: str, *, code: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class ManagedSkillFile:
    path: str
    content: str
    sha256: str
    size_bytes: int
    executable: bool


@dataclass(frozen=True)
class ManagedSkill:
    name: str
    files: tuple[ManagedSkillFile, ...]


@dataclass(frozen=True)
class ManagedSkillInstallation:
    manifest_sha256: str
    skills: tuple[ManagedSkill, ...]


class ManagedSkillsClient:
    """Provider-neutral async client for the sandbox-only skills endpoints."""

    def __init__(
        self,
        control_plane_url: str,
        session_id: str,
        sandbox_token: str,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._base_url = control_plane_url.rstrip("/")
        self._session_id = session_id
        self._headers = {"Authorization": f"Bearer {sandbox_token}"}
        self._transport = transport

    @property
    def _skills_url(self) -> str:
        session_id = quote(self._session_id, safe="")
        return f"{self._base_url}/sessions/{session_id}/sandbox-skills"

    async def fetch_installation(self) -> bytes:
        """Fetch the session-bound installation DTO with bounded retries and response size."""
        last_error: Exception | None = None
        for attempt in range(MANAGED_SKILLS_REQUEST_ATTEMPTS):
            try:
                async with (
                    httpx.AsyncClient(transport=self._transport) as client,
                    client.stream(
                        "GET",
                        self._skills_url,
                        headers=self._headers,
                        timeout=MANAGED_SKILLS_FETCH_TIMEOUT_SECONDS,
                    ) as response,
                ):
                    response.raise_for_status()
                    chunks: list[bytes] = []
                    size = 0
                    async for chunk in response.aiter_bytes():
                        size += len(chunk)
                        if size > MAX_MANAGED_SKILL_RESPONSE_BYTES:
                            raise ManagedSkillsError(
                                "managed skills installation exceeds the size limit",
                                code="installation_too_large",
                            )
                        chunks.append(chunk)
                    return b"".join(chunks)
            except ManagedSkillsError:
                raise
            except (httpx.HTTPError, OSError) as error:
                last_error = error
                if not _retryable_error(error) or attempt == MANAGED_SKILLS_REQUEST_ATTEMPTS - 1:
                    break
                await asyncio.sleep(MANAGED_SKILLS_RETRY_BASE_SECONDS * (2**attempt))
        raise ManagedSkillsError(
            f"failed to fetch managed skills: {last_error}", code="fetch_failed"
        ) from last_error


def _retryable_error(error: Exception) -> bool:
    if isinstance(error, httpx.HTTPStatusError):
        return error.response.status_code in {408, 429} or error.response.status_code >= 500
    return isinstance(error, (httpx.TransportError, OSError))


def _require_object(value: Any, keys: set[str], context: str) -> Mapping[str, Any]:
    if not isinstance(value, dict) or not keys.issubset(value):
        raise ManagedSkillsError(f"invalid {context} object", code="installation_invalid")
    return value


def _require_string(value: Any, context: str, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str) or (not value and not allow_empty):
        raise ManagedSkillsError(f"invalid {context}", code="installation_invalid")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as error:
        raise ManagedSkillsError(
            f"invalid UTF-8 in {context}", code="installation_invalid"
        ) from error
    return value


def _require_int(value: Any, context: str, *, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise ManagedSkillsError(f"invalid {context}", code="installation_invalid")
    return value


def _validate_sha256(value: Any, context: str) -> str:
    digest = _require_string(value, context)
    if not _SHA256_RE.fullmatch(digest):
        raise ManagedSkillsError(f"invalid {context}", code="installation_invalid")
    return digest


def _validate_path(value: Any) -> str:
    path = _require_string(value, "skill file path")
    try:
        encoded = path.encode("utf-8")
    except UnicodeEncodeError as error:
        raise ManagedSkillsError("invalid skill file path", code="path_invalid") from error
    parts = path.split("/")
    if (
        path.startswith("/")
        or "\\" in path
        or any(ord(character) < 32 or ord(character) == 127 for character in path)
        or len(encoded) > MAX_SKILL_PATH_BYTES
        or len(parts) > MAX_SKILL_PATH_DEPTH
        or any(part in {"", ".", ".."} for part in parts)
        or PurePosixPath(path).is_absolute()
    ):
        raise ManagedSkillsError(f"unsafe skill file path: {path!r}", code="path_invalid")
    return path


def validate_installation(raw: bytes) -> ManagedSkillInstallation:
    """Validate untrusted installation bytes independently of the control plane.

    The narrow DTO omits selection and assignment provenance, so manifest_sha256
    is an opaque identifier here. File hashes, paths, sizes, names, and modes are
    validated locally before any content reaches an OpenCode discovery path.
    """
    if len(raw) > MAX_MANAGED_SKILL_RESPONSE_BYTES:
        raise ManagedSkillsError(
            "managed skills installation exceeds the size limit", code="installation_too_large"
        )
    try:
        document = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ManagedSkillsError(
            "managed skills installation is not valid JSON", code="installation_invalid"
        ) from error
    installation = _require_object(
        document,
        {"schemaVersion", "manifestSha256", "skills"},
        "installation",
    )
    if type(installation["schemaVersion"]) is not int or installation["schemaVersion"] != 1:
        raise ManagedSkillsError(
            "unsupported managed skills schema version", code="installation_invalid"
        )
    manifest_sha256 = _validate_sha256(installation["manifestSha256"], "manifest SHA-256")
    raw_skills = installation["skills"]
    if not isinstance(raw_skills, list) or len(raw_skills) > MAX_MANAGED_SKILLS_PER_SESSION:
        raise ManagedSkillsError("invalid managed skills list", code="installation_invalid")

    skills: list[ManagedSkill] = []
    names: set[str] = set()
    installation_content_bytes = 0
    for raw_skill in raw_skills:
        skill = _require_object(
            raw_skill,
            {"name", "files"},
            "skill",
        )
        name = _require_string(skill["name"], "skill name")
        if len(name) > MAX_SKILL_NAME_LENGTH or not _SKILL_NAME_RE.fullmatch(name):
            raise ManagedSkillsError(f"invalid skill name: {name!r}", code="installation_invalid")
        if name in names:
            raise ManagedSkillsError(
                f"duplicate managed skill name: {name}", code="installation_invalid"
            )
        names.add(name)
        raw_files = skill["files"]
        if not isinstance(raw_files, list) or not raw_files or len(raw_files) > MAX_SKILL_FILES:
            raise ManagedSkillsError("invalid skill files list", code="installation_invalid")
        files: list[ManagedSkillFile] = []
        paths: set[str] = set()
        revision_bytes = 0
        for raw_file in raw_files:
            file = _require_object(
                raw_file, {"path", "content", "sha256", "sizeBytes", "executable"}, "skill file"
            )
            path = _validate_path(file["path"])
            if path in paths:
                raise ManagedSkillsError(
                    f"duplicate skill file path: {path}", code="installation_invalid"
                )
            if any(
                path.startswith(f"{existing}/") or existing.startswith(f"{path}/")
                for existing in paths
            ):
                raise ManagedSkillsError(
                    f"conflicting skill file path: {path}", code="path_invalid"
                )
            paths.add(path)
            content = _require_string(file["content"], "skill file content", allow_empty=True)
            content_bytes = content.encode("utf-8")
            size_bytes = _require_int(file["sizeBytes"], "skill file size")
            if len(content_bytes) > MAX_SKILL_FILE_BYTES or size_bytes != len(content_bytes):
                raise ManagedSkillsError(
                    f"invalid size for skill file {path}", code="installation_invalid"
                )
            digest = _validate_sha256(file["sha256"], "skill file SHA-256")
            if not hashlib.sha256(content_bytes).hexdigest() == digest:
                raise ManagedSkillsError(
                    f"SHA-256 mismatch for skill file {path}", code="hash_mismatch"
                )
            executable = file["executable"]
            if not isinstance(executable, bool):
                raise ManagedSkillsError(
                    f"invalid executable flag for {path}", code="installation_invalid"
                )
            if executable and not path.startswith("scripts/"):
                raise ManagedSkillsError(
                    f"executable skill file must be under scripts/: {path}", code="path_invalid"
                )
            revision_bytes += len(content_bytes)
            files.append(ManagedSkillFile(path, content, digest, size_bytes, executable))
        if "SKILL.md" not in paths:
            raise ManagedSkillsError(
                f"managed skill {name} has no SKILL.md", code="installation_invalid"
            )
        skill_markdown = next(file.content for file in files if file.path == "SKILL.md")
        if _canonical_frontmatter_name(skill_markdown) != name:
            raise ManagedSkillsError(
                f"SKILL.md name does not match managed skill {name}", code="installation_invalid"
            )
        if revision_bytes > MAX_SKILL_REVISION_BYTES:
            raise ManagedSkillsError(
                f"invalid total size for managed skill {name}", code="installation_invalid"
            )
        installation_content_bytes += revision_bytes
        skills.append(ManagedSkill(name, tuple(files)))

    if installation_content_bytes > MAX_MANAGED_SKILL_MANIFEST_BYTES:
        raise ManagedSkillsError(
            "managed skills content exceeds the session size limit", code="installation_too_large"
        )

    return ManagedSkillInstallation(manifest_sha256, tuple(skills))


def _canonical_frontmatter_name(markdown: str) -> str | None:
    if not markdown.startswith("---\n"):
        return None
    for line in markdown.splitlines()[1:]:
        if line == "---":
            return None
        match = _YAML_NAME_RE.fullmatch(line)
        if match:
            return next(value for value in match.groups() if value is not None)
    return None


class ManagedSkillsMaterializer:
    """Install a fetched installation DTO into the platform-owned global skills directory."""

    def __init__(
        self,
        client: ManagedSkillsClient,
        destination: Path,
        log: Any,
        *,
        bundled_skills_path: Path = Path("/app/sandbox_runtime/skills"),
    ) -> None:
        self.client = client
        self.destination = destination
        self.log = log
        self.bundled_skills_path = bundled_skills_path

    @staticmethod
    def _remove_path(path: Path) -> None:
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path)
        else:
            path.unlink(missing_ok=True)

    def _repair_interrupted_swap(self, staging: Path, backup: Path, journal: Path) -> None:
        """Restore the last complete tree or finish cleanup after an interrupted swap."""
        if not journal.exists():
            self._remove_path(staging)
            self._remove_path(backup)
            return
        if self.destination.exists() or self.destination.is_symlink():
            self._remove_path(backup)
        elif backup.exists() or backup.is_symlink():
            backup.rename(self.destination)
        self._remove_path(staging)
        journal.unlink(missing_ok=True)
        self._fsync_directory(self.destination.parent)

    @staticmethod
    def _skill_names(skill_dir: Path) -> set[str]:
        names = {skill_dir.name}
        skill_file = skill_dir / "SKILL.md"
        if skill_file.is_file() and not skill_file.is_symlink():
            try:
                with skill_file.open("rb") as file:
                    content = file.read(65536)
                if content.startswith(b"---\n"):
                    for raw_line in content.splitlines()[1:]:
                        if raw_line == b"---":
                            break
                        line = raw_line.decode("utf-8")
                        match = _YAML_NAME_RE.match(line)
                        if match:
                            name = next(value for value in match.groups() if value is not None)
                            if _SKILL_NAME_RE.fullmatch(name):
                                names.add(name)
                            break
            except (OSError, UnicodeDecodeError):
                pass
        return names

    def _collision_roots(self, repositories: Sequence[RepoEntry], workdir: Path) -> Iterable[Path]:
        yield self.bundled_skills_path
        bases = [workdir, *(repository.path for repository in repositories), Path.home()]
        seen: set[Path] = set()
        for base in bases:
            for relative in _DISCOVERY_PATHS:
                root = base / relative
                if root == self.destination or root in seen:
                    continue
                seen.add(root)
                yield root

    def _check_collisions(
        self,
        installation: ManagedSkillInstallation,
        repositories: Sequence[RepoEntry],
        workdir: Path,
    ) -> None:
        """Reject ambiguous names across every OpenCode skill discovery root."""
        selected = {skill.name for skill in installation.skills}
        for root in self._collision_roots(repositories, workdir):
            if not root.is_dir():
                continue
            for child in root.iterdir():
                if not child.is_dir():
                    continue
                collisions = self._skill_names(child) & selected
                if collisions:
                    name = sorted(collisions)[0]
                    raise ManagedSkillsError(
                        f"managed skill {name!r} collides with discovered skill at {child}",
                        code="name_collision",
                    )

    @staticmethod
    def _write_journal(journal: Path) -> None:
        journal.parent.mkdir(parents=True, exist_ok=True)
        temporary = journal.with_name(f".{journal.name}.{uuid.uuid4().hex}.tmp")
        temporary.write_text("", encoding="utf-8")
        ManagedSkillsMaterializer._fsync_file(temporary)
        temporary.replace(journal)
        ManagedSkillsMaterializer._fsync_directory(journal.parent)

    @staticmethod
    def _fsync_file(path: Path) -> None:
        descriptor = os.open(path, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    @staticmethod
    def _fsync_directory(path: Path) -> None:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    @staticmethod
    def _write_file(path: Path, file: ManagedSkillFile) -> None:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        descriptor = os.open(path, flags, 0o500 if file.executable else 0o400)
        try:
            content = file.content.encode("utf-8")
            with os.fdopen(descriptor, "wb", closefd=False) as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            if hashlib.sha256(path.read_bytes()).hexdigest() != file.sha256:
                raise ManagedSkillsError(
                    f"installed SHA-256 mismatch for {file.path}", code="install_failed"
                )
            os.fchmod(descriptor, 0o500 if file.executable else 0o400)
        finally:
            os.close(descriptor)

    def _install(self, installation: ManagedSkillInstallation) -> None:
        """Replace the complete managed tree using a recoverable same-filesystem swap.

        The durable marker must precede moving the current tree. Recovery keeps
        an installed destination when present, or restores the backup otherwise.
        """
        parent = self.destination.parent
        parent.mkdir(parents=True, exist_ok=True)
        staging = parent / ".managed-skills-staging"
        backup = parent / ".managed-skills-backup"
        journal = parent / ".managed-skills-swap"
        self._repair_interrupted_swap(staging, backup, journal)
        if self.destination.is_symlink() or (
            self.destination.exists() and not self.destination.is_dir()
        ):
            raise ManagedSkillsError(
                "managed skills destination is not a directory", code="install_failed"
            )

        staging.mkdir(mode=0o700)
        try:
            for skill in sorted(installation.skills, key=lambda item: item.name.encode("utf-8")):
                skill_dir = staging / skill.name
                skill_dir.mkdir(mode=0o700)
                for file in sorted(skill.files, key=lambda item: item.path.encode("utf-8")):
                    self._write_file(skill_dir / PurePosixPath(file.path), file)
            self._write_journal(journal)
            if self.destination.exists():
                self.destination.rename(backup)
                self._fsync_directory(parent)
            staging.rename(self.destination)
            self._fsync_directory(parent)
            self._remove_path(backup)
            journal.unlink(missing_ok=True)
            self._fsync_directory(parent)
        except Exception:
            if not self.destination.exists() and backup.exists():
                backup.rename(self.destination)
            self._remove_path(staging)
            journal.unlink(missing_ok=True)
            raise

    async def materialize(self, repositories: Sequence[RepoEntry], workdir: Path) -> None:
        """Fetch, validate, collision-check, and install skills before OpenCode starts."""
        try:
            raw = await self.client.fetch_installation()
            installation = validate_installation(raw)
            self._check_collisions(installation, repositories, workdir)
            self._install(installation)
        except ManagedSkillsError:
            raise
        except Exception as error:
            raise ManagedSkillsError(
                f"failed to install managed skills: {error}", code="install_failed"
            ) from error

        self.log.info(
            "managed_skills.materialized",
            manifest_sha256=installation.manifest_sha256,
            skill_count=len(installation.skills),
        )

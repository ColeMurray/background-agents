"""Fetch, validate, and install control-plane-managed OpenCode skills."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import shutil
import struct
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
_REVISION_DOMAIN = b"OPEN_INSPECT_SKILL_REVISION_V1\0"
_MANIFEST_DOMAIN = b"OPEN_INSPECT_SKILL_MANIFEST_V1\0"
_SKILL_RESOLVER_VERSION = 1
_DISCOVERY_PATHS = (".opencode/skills", ".claude/skills", ".agents/skills")


class ManagedSkillsError(RuntimeError):
    """A managed-skill startup failure with a stable activation error code."""

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
    skill_id: str
    revision_id: str
    name: str
    content_sha256: str
    files: tuple[ManagedSkillFile, ...]


@dataclass(frozen=True)
class ManagedSkillManifest:
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

    async def fetch_manifest(self) -> bytes:
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
                                "managed skills manifest exceeds the size limit",
                                code="manifest_too_large",
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

    async def report_activation(
        self,
        manifest_sha256: str,
        status: str,
        *,
        error_code: str | None = None,
        message: str | None = None,
    ) -> None:
        body: dict[str, str] = {"manifestSha256": manifest_sha256, "status": status}
        if error_code:
            body["errorCode"] = error_code[:100]
        if message:
            body["message"] = message[:1000]
        for attempt in range(MANAGED_SKILLS_REQUEST_ATTEMPTS):
            try:
                async with httpx.AsyncClient(transport=self._transport) as client:
                    response = await client.post(
                        f"{self._skills_url}/activation",
                        headers=self._headers,
                        json=body,
                        timeout=MANAGED_SKILLS_FETCH_TIMEOUT_SECONDS,
                    )
                    response.raise_for_status()
                    return
            except (httpx.HTTPError, OSError) as error:
                if not _retryable_error(error) or attempt == MANAGED_SKILLS_REQUEST_ATTEMPTS - 1:
                    raise
                await asyncio.sleep(MANAGED_SKILLS_RETRY_BASE_SECONDS * (2**attempt))


def _retryable_error(error: Exception) -> bool:
    if isinstance(error, httpx.HTTPStatusError):
        return error.response.status_code in {408, 429} or error.response.status_code >= 500
    return isinstance(error, (httpx.TransportError, OSError))


def _require_object(value: Any, keys: set[str], context: str) -> Mapping[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        raise ManagedSkillsError(f"invalid {context} object", code="manifest_invalid")
    return value


def _require_string(value: Any, context: str, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str) or (not value and not allow_empty):
        raise ManagedSkillsError(f"invalid {context}", code="manifest_invalid")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as error:
        raise ManagedSkillsError(f"invalid UTF-8 in {context}", code="manifest_invalid") from error
    return value


def _require_int(value: Any, context: str, *, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise ManagedSkillsError(f"invalid {context}", code="manifest_invalid")
    return value


def _validate_sha256(value: Any, context: str) -> str:
    digest = _require_string(value, context)
    if not _SHA256_RE.fullmatch(digest):
        raise ManagedSkillsError(f"invalid {context}", code="manifest_invalid")
    return digest


def _validate_selection(value: Any) -> None:
    if not isinstance(value, dict):
        raise ManagedSkillsError("invalid selection object", code="manifest_invalid")
    mode = value.get("mode")
    if not isinstance(mode, str):
        raise ManagedSkillsError("invalid selection mode", code="manifest_invalid")
    expected = {"mode", "profileId", "profileName"} if mode == "profile" else {"mode"}
    _require_object(value, expected, "selection")
    if mode not in {"all", "none", "profile"}:
        raise ManagedSkillsError("invalid selection mode", code="manifest_invalid")
    if mode == "profile":
        _require_string(value["profileId"], "selection profile ID")
        _require_string(value["profileName"], "selection profile name")


def _validate_assignment(value: Any) -> None:
    if not isinstance(value, dict):
        raise ManagedSkillsError("invalid assignment source", code="manifest_invalid")
    assignment_type = value.get("type")
    if not isinstance(assignment_type, str):
        raise ManagedSkillsError("invalid assignment type", code="manifest_invalid")
    keys_by_type = {
        "global": {"id", "type"},
        "repository": {"id", "type", "repoOwner", "repoName"},
        "environment": {"id", "type", "environmentId"},
    }
    expected = keys_by_type.get(assignment_type)
    if expected is None:
        raise ManagedSkillsError("invalid assignment type", code="manifest_invalid")
    if assignment_type == "environment" and "environmentName" in value:
        expected = expected | {"environmentName"}
    assignment = _require_object(value, expected, "assignment source")
    for key, item in assignment.items():
        if key != "type":
            _require_string(item, f"assignment {key}")


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


def _revision_digest(files: Sequence[ManagedSkillFile]) -> str:
    encoded = bytearray(_REVISION_DOMAIN)
    encoded.extend(struct.pack(">I", len(files)))
    for file in sorted(files, key=lambda item: item.path.encode("utf-8")):
        path = file.path.encode("utf-8")
        content = file.content.encode("utf-8")
        encoded.extend(struct.pack(">I", len(path)))
        encoded.extend(path)
        encoded.append(1 if file.executable else 0)
        encoded.extend(struct.pack(">Q", len(content)))
        encoded.extend(content)
    return hashlib.sha256(encoded).hexdigest()


def _encoded_string(value: str) -> bytes:
    encoded = value.encode("utf-8")
    return struct.pack(">I", len(encoded)) + encoded


def _assignment_values(source: Mapping[str, Any]) -> tuple[str, str, str, str, str, str]:
    assignment_type = source["type"]
    if assignment_type == "repository":
        return (
            assignment_type,
            source["id"],
            source["repoOwner"],
            source["repoName"],
            "",
            "",
        )
    if assignment_type == "environment":
        return (
            assignment_type,
            source["id"],
            "",
            "",
            source["environmentId"],
            source.get("environmentName", ""),
        )
    return (assignment_type, source["id"], "", "", "", "")


def _manifest_digest(
    resolver_version: int, selection: Mapping[str, Any], skills: Sequence[Mapping[str, Any]]
) -> str:
    mode = selection["mode"]
    selection_byte = {"all": 0, "none": 1, "profile": 2}[mode]
    encoded = bytearray(_MANIFEST_DOMAIN)
    encoded.extend(struct.pack(">I", resolver_version))
    encoded.append(selection_byte)
    if mode == "profile":
        encoded.extend(_encoded_string(selection["profileId"]))
        encoded.extend(_encoded_string(selection["profileName"]))
    ordered_skills = sorted(
        skills, key=lambda skill: (skill["name"].encode("utf-8"), skill["skillId"].encode("utf-8"))
    )
    encoded.extend(struct.pack(">I", len(ordered_skills)))
    for skill in ordered_skills:
        encoded.extend(_encoded_string(skill["skillId"]))
        encoded.extend(_encoded_string(skill["revisionId"]))
        encoded.extend(_encoded_string(skill["name"]))
        encoded.extend(bytes.fromhex(skill["contentSha256"]))
        sources = sorted(skill["assignmentSources"], key=_assignment_values)
        encoded.extend(struct.pack(">I", len(sources)))
        for source in sources:
            for value in _assignment_values(source):
                encoded.extend(_encoded_string(value))
    return hashlib.sha256(encoded).hexdigest()


def validate_manifest(raw: bytes) -> ManagedSkillManifest:
    """Validate the shared sandbox manifest contract and all content bounds."""
    if len(raw) > MAX_MANAGED_SKILL_RESPONSE_BYTES:
        raise ManagedSkillsError(
            "managed skills manifest exceeds the size limit", code="manifest_too_large"
        )
    try:
        document = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ManagedSkillsError(
            "managed skills manifest is not valid JSON", code="manifest_invalid"
        ) from error
    manifest = _require_object(
        document,
        {"schemaVersion", "resolverVersion", "manifestSha256", "selection", "skills"},
        "manifest",
    )
    if type(manifest["schemaVersion"]) is not int or manifest["schemaVersion"] != 1:
        raise ManagedSkillsError(
            "unsupported managed skills schema version", code="manifest_invalid"
        )
    resolver_version = _require_int(manifest["resolverVersion"], "resolver version", minimum=1)
    if resolver_version != _SKILL_RESOLVER_VERSION:
        raise ManagedSkillsError(
            "unsupported managed skills resolver version", code="manifest_invalid"
        )
    manifest_sha256 = _validate_sha256(manifest["manifestSha256"], "manifest SHA-256")
    _validate_selection(manifest["selection"])
    raw_skills = manifest["skills"]
    if not isinstance(raw_skills, list) or len(raw_skills) > MAX_MANAGED_SKILLS_PER_SESSION:
        raise ManagedSkillsError("invalid managed skills list", code="manifest_invalid")

    skills: list[ManagedSkill] = []
    names: set[str] = set()
    manifest_content_bytes = 0
    for raw_skill in raw_skills:
        skill = _require_object(
            raw_skill,
            {
                "skillId",
                "revisionId",
                "name",
                "description",
                "revisionNumber",
                "contentSha256",
                "totalBytes",
                "assignmentSources",
                "files",
            },
            "skill",
        )
        skill_id = _require_string(skill["skillId"], "skill ID")
        revision_id = _require_string(skill["revisionId"], "revision ID")
        name = _require_string(skill["name"], "skill name")
        if len(name) > MAX_SKILL_NAME_LENGTH or not _SKILL_NAME_RE.fullmatch(name):
            raise ManagedSkillsError(f"invalid skill name: {name!r}", code="manifest_invalid")
        if name in names:
            raise ManagedSkillsError(
                f"duplicate managed skill name: {name}", code="manifest_invalid"
            )
        names.add(name)
        description = _require_string(skill["description"], "skill description", allow_empty=True)
        if len(description) > 1024:
            raise ManagedSkillsError("skill description is too long", code="manifest_invalid")
        _require_int(skill["revisionNumber"], "revision number", minimum=1)
        content_sha256 = _validate_sha256(skill["contentSha256"], "content SHA-256")
        total_bytes = _require_int(skill["totalBytes"], "skill total bytes")
        assignments = skill["assignmentSources"]
        if not isinstance(assignments, list):
            raise ManagedSkillsError("invalid assignment sources", code="manifest_invalid")
        for assignment in assignments:
            _validate_assignment(assignment)

        raw_files = skill["files"]
        if not isinstance(raw_files, list) or not raw_files or len(raw_files) > MAX_SKILL_FILES:
            raise ManagedSkillsError("invalid skill files list", code="manifest_invalid")
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
                    f"duplicate skill file path: {path}", code="manifest_invalid"
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
                    f"invalid size for skill file {path}", code="manifest_invalid"
                )
            digest = _validate_sha256(file["sha256"], "skill file SHA-256")
            if not hashlib.sha256(content_bytes).hexdigest() == digest:
                raise ManagedSkillsError(
                    f"SHA-256 mismatch for skill file {path}", code="hash_mismatch"
                )
            executable = file["executable"]
            if not isinstance(executable, bool):
                raise ManagedSkillsError(
                    f"invalid executable flag for {path}", code="manifest_invalid"
                )
            if executable and not path.startswith("scripts/"):
                raise ManagedSkillsError(
                    f"executable skill file must be under scripts/: {path}", code="path_invalid"
                )
            revision_bytes += len(content_bytes)
            files.append(ManagedSkillFile(path, content, digest, size_bytes, executable))
        if "SKILL.md" not in paths:
            raise ManagedSkillsError(
                f"managed skill {name} has no SKILL.md", code="manifest_invalid"
            )
        skill_markdown = next(file.content for file in files if file.path == "SKILL.md")
        if _canonical_frontmatter_name(skill_markdown) != name:
            raise ManagedSkillsError(
                f"SKILL.md name does not match managed skill {name}", code="manifest_invalid"
            )
        if revision_bytes > MAX_SKILL_REVISION_BYTES or total_bytes != revision_bytes:
            raise ManagedSkillsError(
                f"invalid total size for managed skill {name}", code="manifest_invalid"
            )
        manifest_content_bytes += revision_bytes
        if _revision_digest(files) != content_sha256:
            raise ManagedSkillsError(
                f"content SHA-256 mismatch for managed skill {name}", code="hash_mismatch"
            )
        skills.append(ManagedSkill(skill_id, revision_id, name, content_sha256, tuple(files)))

    if manifest_content_bytes > MAX_MANAGED_SKILL_MANIFEST_BYTES:
        raise ManagedSkillsError(
            "managed skills content exceeds the session size limit", code="manifest_too_large"
        )

    if _manifest_digest(resolver_version, manifest["selection"], raw_skills) != manifest_sha256:
        raise ManagedSkillsError("managed skills manifest SHA-256 mismatch", code="hash_mismatch")
    return ManagedSkillManifest(manifest_sha256, tuple(skills))


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
    """Install a fetched manifest into the platform-owned global skills directory."""

    def __init__(
        self,
        client: ManagedSkillsClient,
        destination: Path,
        state_path: Path,
        log: Any,
        *,
        bundled_skills_path: Path = Path("/app/sandbox_runtime/skills"),
    ) -> None:
        self.client = client
        self.destination = destination
        self.state_path = state_path
        self.log = log
        self.bundled_skills_path = bundled_skills_path

    @staticmethod
    def _remove_path(path: Path) -> None:
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path)
        else:
            path.unlink(missing_ok=True)

    def _repair_interrupted_swap(self, staging: Path, backup: Path, journal: Path) -> None:
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
        if journal.parent != self.destination.parent:
            self._fsync_directory(journal.parent)

    @staticmethod
    def _skill_names(skill_dir: Path) -> set[str]:
        names = {skill_dir.name}
        skill_file = skill_dir / "SKILL.md"
        if skill_file.is_file() and not skill_file.is_symlink():
            try:
                text = skill_file.read_text(encoding="utf-8")[:65536]
                if text.startswith("---\n"):
                    for line in text.splitlines()[1:]:
                        if line == "---":
                            break
                        match = _YAML_NAME_RE.match(line)
                        if match:
                            name = next(value for value in match.groups() if value is not None)
                            if _SKILL_NAME_RE.fullmatch(name):
                                names.add(name)
                            break
            except OSError:
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
        self, manifest: ManagedSkillManifest, repositories: Sequence[RepoEntry], workdir: Path
    ) -> None:
        selected = {skill.name for skill in manifest.skills}
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

    def _install(self, manifest: ManagedSkillManifest) -> None:
        parent = self.destination.parent
        parent.mkdir(parents=True, exist_ok=True)
        staging = parent / ".managed-skills-staging"
        backup = parent / ".managed-skills-backup"
        journal = self.state_path.with_name("managed-skills-activation.json")
        self._repair_interrupted_swap(staging, backup, journal)
        if self.destination.is_symlink() or (
            self.destination.exists() and not self.destination.is_dir()
        ):
            raise ManagedSkillsError(
                "managed skills destination is not a directory", code="install_failed"
            )

        staging.mkdir(mode=0o700)
        try:
            for skill in sorted(manifest.skills, key=lambda item: item.name.encode("utf-8")):
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
            if journal.parent != parent:
                self._fsync_directory(journal.parent)
        except Exception:
            if not self.destination.exists() and backup.exists():
                backup.rename(self.destination)
            self._remove_path(staging)
            journal.unlink(missing_ok=True)
            if journal.parent != parent:
                self._fsync_directory(journal.parent)
            raise

        state = {
            "schemaVersion": 1,
            "manifestSha256": manifest.manifest_sha256,
            "skills": [
                {
                    "skillId": skill.skill_id,
                    "revisionId": skill.revision_id,
                    "name": skill.name,
                    "contentSha256": skill.content_sha256,
                }
                for skill in manifest.skills
            ],
        }
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.state_path.with_name(f".{self.state_path.name}.tmp")
        temporary.write_text(json.dumps(state, sort_keys=True), encoding="utf-8")
        self._fsync_file(temporary)
        temporary.replace(self.state_path)
        self._fsync_directory(self.state_path.parent)

    async def activate(self, repositories: Sequence[RepoEntry], workdir: Path) -> None:
        manifest_sha256: str | None = None
        try:
            raw = await self.client.fetch_manifest()
            try:
                unvalidated = json.loads(raw)
                candidate = (
                    unvalidated.get("manifestSha256") if isinstance(unvalidated, dict) else None
                )
                if isinstance(candidate, str) and _SHA256_RE.fullmatch(candidate):
                    manifest_sha256 = candidate
            except (UnicodeDecodeError, json.JSONDecodeError):
                pass
            manifest = validate_manifest(raw)
            manifest_sha256 = manifest.manifest_sha256
            self._check_collisions(manifest, repositories, workdir)
            self._install(manifest)
        except ManagedSkillsError as error:
            if manifest_sha256:
                try:
                    await self.client.report_activation(
                        manifest_sha256, "failed", error_code=error.code, message=str(error)
                    )
                except Exception as report_error:
                    self.log.warn("managed_skills.activation_report_failed", exc=report_error)
            raise
        except Exception as error:
            if manifest_sha256:
                try:
                    await self.client.report_activation(
                        manifest_sha256,
                        "failed",
                        error_code="install_failed",
                        message=str(error),
                    )
                except Exception as report_error:
                    self.log.warn("managed_skills.activation_report_failed", exc=report_error)
            raise ManagedSkillsError(
                f"failed to install managed skills: {error}", code="install_failed"
            ) from error

        try:
            await self.client.report_activation(manifest.manifest_sha256, "activated")
        except Exception as error:
            self.log.warn("managed_skills.activation_report_failed", exc=error)
        self.log.info(
            "managed_skills.activated",
            manifest_sha256=manifest.manifest_sha256,
            skill_count=len(manifest.skills),
        )

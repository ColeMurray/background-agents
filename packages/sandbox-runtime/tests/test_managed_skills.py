import asyncio
import hashlib
import json
import struct
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from sandbox_runtime.managed_skills import (
    MAX_MANAGED_SKILL_MANIFEST_BYTES,
    MAX_MANAGED_SKILLS_PER_SESSION,
    MAX_SKILL_FILE_BYTES,
    MAX_SKILL_FILES,
    MAX_SKILL_PATH_BYTES,
    MAX_SKILL_PATH_DEPTH,
    MAX_SKILL_REVISION_BYTES,
    ManagedSkillsClient,
    ManagedSkillsError,
    ManagedSkillsMaterializer,
    validate_manifest,
)
from tests.runtime_helpers import make_opencode_server


def _revision_sha(files):
    encoded = bytearray(b"OPEN_INSPECT_SKILL_REVISION_V1\0")
    encoded.extend(struct.pack(">I", len(files)))
    for file in sorted(files, key=lambda item: item["path"].encode()):
        path = file["path"].encode()
        content = file["content"].encode()
        encoded.extend(struct.pack(">I", len(path)))
        encoded.extend(path)
        encoded.append(1 if file["executable"] else 0)
        encoded.extend(struct.pack(">Q", len(content)))
        encoded.extend(content)
    return hashlib.sha256(encoded).hexdigest()


def _encoded_string(value):
    encoded = value.encode()
    return struct.pack(">I", len(encoded)) + encoded


def _manifest_sha(document):
    skill = document["skills"][0]
    encoded = bytearray(b"OPEN_INSPECT_SKILL_MANIFEST_V1\0")
    encoded.extend(struct.pack(">I", 1))
    encoded.append(0)
    encoded.extend(struct.pack(">I", 1))
    encoded.extend(_encoded_string(skill["skillId"]))
    encoded.extend(_encoded_string(skill["revisionId"]))
    encoded.extend(_encoded_string(skill["name"]))
    encoded.extend(bytes.fromhex(skill["contentSha256"]))
    encoded.extend(struct.pack(">I", 1))
    for value in ("global", "assignment-1", "", "", "", ""):
        encoded.extend(_encoded_string(value))
    return hashlib.sha256(encoded).hexdigest()


def _manifest(*, name="managed", path="SKILL.md", content=None):
    if content is None:
        content = f'---\nname: {name}\ndescription: "Managed skill"\n---\n# Managed\n'
    content_bytes = content.encode()
    files = [
        {
            "path": path,
            "content": content,
            "sha256": hashlib.sha256(content_bytes).hexdigest(),
            "sizeBytes": len(content_bytes),
            "executable": False,
        }
    ]
    document = {
        "schemaVersion": 1,
        "resolverVersion": 1,
        "manifestSha256": "a" * 64,
        "selection": {"mode": "all"},
        "skills": [
            {
                "skillId": "skill-1",
                "revisionId": "revision-1",
                "name": name,
                "description": "Managed skill",
                "revisionNumber": 1,
                "contentSha256": _revision_sha(files),
                "totalBytes": len(content_bytes),
                "assignmentSources": [{"id": "assignment-1", "type": "global"}],
                "files": files,
            }
        ],
    }
    document["manifestSha256"] = _manifest_sha(document)
    return document


@pytest.mark.parametrize("path", ["../escape", "scripts/../../escape", "/absolute", "a\\b"])
def test_manifest_rejects_traversal_paths(path):
    with pytest.raises(ManagedSkillsError, match="path"):
        validate_manifest(json.dumps(_manifest(path=path)).encode())


def test_manifest_rejects_file_hash_mismatch():
    document = _manifest()
    document["skills"][0]["files"][0]["sha256"] = "0" * 64

    with pytest.raises(ManagedSkillsError, match="SHA-256 mismatch"):
        validate_manifest(json.dumps(document).encode())


def test_manifest_rejects_mismatched_frontmatter_name():
    document = _manifest(content="---\nname: other\n---\n")

    with pytest.raises(ManagedSkillsError, match="does not match"):
        validate_manifest(json.dumps(document).encode())


def test_cross_language_golden_manifest():
    fixture_path = (
        Path(__file__).resolve().parents[2]
        / "shared"
        / "test-fixtures"
        / "managed-skills-golden.json"
    )
    golden = json.loads(fixture_path.read_text())

    manifest = validate_manifest(json.dumps(golden["manifest"]).encode())

    assert manifest.manifest_sha256 == golden["manifestSha256"]
    assert manifest.skills[0].content_sha256 == golden["revisionSha256"]
    assert golden["limits"] == {
        "maxSkillFiles": MAX_SKILL_FILES,
        "maxSkillFileBytes": MAX_SKILL_FILE_BYTES,
        "maxSkillRevisionBytes": MAX_SKILL_REVISION_BYTES,
        "maxSkillPathBytes": MAX_SKILL_PATH_BYTES,
        "maxSkillPathDepth": MAX_SKILL_PATH_DEPTH,
        "maxManagedSkillsPerSession": MAX_MANAGED_SKILLS_PER_SESSION,
        "maxManagedSkillManifestBytes": MAX_MANAGED_SKILL_MANIFEST_BYTES,
    }


async def test_client_uses_session_url_and_sandbox_bearer_auth():
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(200, content=json.dumps({"schemaVersion": 1}).encode())

    client = ManagedSkillsClient(
        "https://control.example/",
        "session/one",
        "sandbox-token",
        transport=httpx.MockTransport(handler),
    )

    await client.fetch_manifest()

    assert requests[0].url == "https://control.example/sessions/session%2Fone/sandbox-skills"
    assert requests[0].headers["Authorization"] == "Bearer sandbox-token"


async def test_client_retries_transient_fetch_failures(monkeypatch):
    attempts = 0

    def handler(_request):
        nonlocal attempts
        attempts += 1
        return httpx.Response(503 if attempts < 3 else 200, content=b"ok")

    sleep = AsyncMock()
    monkeypatch.setattr("sandbox_runtime.managed_skills.asyncio.sleep", sleep)
    client = ManagedSkillsClient(
        "https://control.example", "session", "token", transport=httpx.MockTransport(handler)
    )

    assert await client.fetch_manifest() == b"ok"
    assert attempts == 3
    assert sleep.await_count == 2


async def test_materializer_replaces_destination_and_reports_activation(tmp_path):
    document = _manifest()
    manifest_sha256 = document["manifestSha256"]
    client = MagicMock()
    client.fetch_manifest = AsyncMock(return_value=json.dumps(document).encode())
    client.report_activation = AsyncMock()
    destination = tmp_path / "config" / "opencode" / "skills"
    destination.mkdir(parents=True)
    (destination / "stale.txt").write_text("stale")
    materializer = ManagedSkillsMaterializer(
        client,
        destination,
        tmp_path / "config" / "open-inspect" / "managed-skills-manifest.json",
        MagicMock(),
        bundled_skills_path=tmp_path / "missing-bundled",
    )

    await materializer.activate((), tmp_path / "workspace")

    assert not (destination / "stale.txt").exists()
    assert "name: managed" in (destination / "managed" / "SKILL.md").read_text()
    assert (destination / "managed" / "SKILL.md").stat().st_mode & 0o777 == 0o400
    client.report_activation.assert_awaited_once_with(manifest_sha256, "activated")


async def test_materializer_rejects_bundled_name_collision(tmp_path):
    document = _manifest(name="conflict")
    manifest_sha256 = document["manifestSha256"]
    client = MagicMock()
    client.fetch_manifest = AsyncMock(return_value=json.dumps(document).encode())
    client.report_activation = AsyncMock()
    bundled = tmp_path / "bundled" / "conflict"
    bundled.mkdir(parents=True)
    (bundled / "SKILL.md").write_text("---\nname: conflict\n---\n")
    materializer = ManagedSkillsMaterializer(
        client,
        tmp_path / "global" / "skills",
        tmp_path / "state" / "manifest.json",
        MagicMock(),
        bundled_skills_path=tmp_path / "bundled",
    )

    with pytest.raises(ManagedSkillsError, match="collides"):
        await materializer.activate((), tmp_path / "workspace")

    client.report_activation.assert_awaited_once_with(
        manifest_sha256,
        "failed",
        error_code="name_collision",
        message=str(client.report_activation.await_args.kwargs["message"]),
    )


def test_materializer_repairs_interrupted_swap(tmp_path):
    destination = tmp_path / "skills"
    backup = tmp_path / ".managed-skills-backup"
    staging = tmp_path / ".managed-skills-staging"
    journal = tmp_path / "managed-skills-activation.json"
    backup.mkdir()
    staging.mkdir()
    (backup / "previous").write_text("ok")
    journal.write_text('{"state":"previous_moved"}')
    materializer = ManagedSkillsMaterializer(
        MagicMock(), destination, tmp_path / "manifest.json", MagicMock()
    )

    materializer._repair_interrupted_swap(staging, backup, journal)

    assert (destination / "previous").read_text() == "ok"
    assert not staging.exists()
    assert not journal.exists()


async def test_opencode_activates_skills_before_spawning(tmp_path, monkeypatch):
    events = []
    materializer = MagicMock()
    materializer.activate = AsyncMock(side_effect=lambda *_args: events.append("skills"))
    server = make_opencode_server(workspace_path=tmp_path)
    server.managed_skills = materializer
    monkeypatch.setattr(server, "_setup_managed_oauth", MagicMock())
    monkeypatch.setattr(server, "_prepare_opencode_filesystem", MagicMock(return_value=set()))
    monkeypatch.setattr(server, "_wait_for_health", AsyncMock())

    process = MagicMock()
    process.stdout = None
    process.returncode = None

    async def spawn(*_args, **_kwargs):
        events.append("spawn")
        return process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)

    await server.start((), tmp_path)

    assert events == ["skills", "spawn"]


async def test_opencode_does_not_spawn_when_skill_activation_fails(tmp_path, monkeypatch):
    materializer = MagicMock()
    materializer.activate = AsyncMock(
        side_effect=ManagedSkillsError("fetch failed", code="fetch_failed")
    )
    server = make_opencode_server(workspace_path=tmp_path)
    server.managed_skills = materializer
    monkeypatch.setattr(server, "_setup_managed_oauth", MagicMock())
    monkeypatch.setattr(server, "_prepare_opencode_filesystem", MagicMock(return_value=set()))
    spawn = AsyncMock()
    monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)

    with pytest.raises(ManagedSkillsError, match="fetch failed"):
        await server.start((), tmp_path)

    spawn.assert_not_awaited()

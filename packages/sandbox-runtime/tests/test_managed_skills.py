import asyncio
import hashlib
import json
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from sandbox_runtime.entrypoint import build_supervisor
from sandbox_runtime.managed_skills import (
    ManagedSkillsClient,
    ManagedSkillsError,
    ManagedSkillsMaterializer,
    validate_installation,
)


def _installation(*, name="managed", path="SKILL.md", content=None):
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
        "manifestSha256": "a" * 64,
        "skills": [
            {
                "name": name,
                "files": files,
            }
        ],
    }
    return document


@pytest.mark.parametrize("path", ["../escape", "scripts/../../escape", "/absolute", "a\\b"])
def test_installation_rejects_traversal_paths(path):
    with pytest.raises(ManagedSkillsError, match="path"):
        validate_installation(json.dumps(_installation(path=path)).encode())


def test_installation_rejects_file_hash_mismatch():
    document = _installation()
    document["skills"][0]["files"][0]["sha256"] = "0" * 64

    with pytest.raises(ManagedSkillsError, match="SHA-256 mismatch"):
        validate_installation(json.dumps(document).encode())


def test_installation_rejects_mismatched_frontmatter_name():
    document = _installation(content="---\nname: other\n---\n")

    with pytest.raises(ManagedSkillsError, match="does not match"):
        validate_installation(json.dumps(document).encode())


@pytest.mark.parametrize(
    "paths",
    [
        ("references", "references/guide.md"),
        ("references/guide.md", "references"),
    ],
)
def test_installation_rejects_file_ancestor_conflicts_in_either_order(paths):
    document = _installation()
    files = document["skills"][0]["files"]
    for path in paths:
        content = f"content for {path}"
        files.append(
            {
                "path": path,
                "content": content,
                "sha256": hashlib.sha256(content.encode()).hexdigest(),
                "sizeBytes": len(content.encode()),
                "executable": False,
            }
        )

    with pytest.raises(ManagedSkillsError, match="conflicting skill file path"):
        validate_installation(json.dumps(document).encode())


def test_installation_ignores_additive_contract_fields():
    document = _installation()
    document["futureManifestField"] = True
    document["skills"][0]["futureSkillField"] = "value"
    document["skills"][0]["files"][0]["futureFileField"] = 1

    installation = validate_installation(json.dumps(document).encode())

    assert installation.skills[0].name == "managed"


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

    await client.fetch_installation()

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

    assert await client.fetch_installation() == b"ok"
    assert attempts == 3
    assert sleep.await_count == 2


async def test_materializer_replaces_destination(tmp_path):
    document = _installation()
    client = MagicMock()
    client.fetch_installation = AsyncMock(return_value=json.dumps(document).encode())
    destination = tmp_path / "config" / "opencode" / "skills"
    destination.mkdir(parents=True)
    (destination / "stale.txt").write_text("stale")
    materializer = ManagedSkillsMaterializer(
        client,
        destination,
        MagicMock(),
        bundled_skills_path=tmp_path / "missing-bundled",
    )

    await materializer.materialize((), tmp_path / "workspace")

    assert not (destination / "stale.txt").exists()
    assert "name: managed" in (destination / "managed" / "SKILL.md").read_text()
    assert (destination / "managed" / "SKILL.md").stat().st_mode & 0o777 == 0o400


async def test_materializer_drops_only_managed_skills_that_collide_with_discovered_skills(tmp_path):
    document = _installation(name="conflict")
    document["skills"].append(_installation(name="alias")["skills"][0])
    document["skills"].append(_installation(name="bundled")["skills"][0])
    document["skills"].append(_installation(name="kept")["skills"][0])
    client = MagicMock()
    client.fetch_installation = AsyncMock(return_value=json.dumps(document).encode())
    repository = tmp_path / "repository"
    discovered = repository / ".claude" / "skills" / "conflict"
    discovered.mkdir(parents=True)
    (discovered / "SKILL.md").write_text("---\nname: conflict\n---\n")
    alias_discovered = repository / ".agents" / "skills" / "different-directory"
    alias_discovered.mkdir(parents=True)
    (alias_discovered / "SKILL.md").write_text("---\nname: alias\n---\n")
    bundled_discovered = tmp_path / "bundled" / "bundled"
    bundled_discovered.mkdir(parents=True)
    (bundled_discovered / "SKILL.md").write_text("---\nname: bundled\n---\n")
    destination = tmp_path / "global" / "skills"
    log = MagicMock()
    materializer = ManagedSkillsMaterializer(
        client,
        destination,
        log,
        bundled_skills_path=tmp_path / "bundled",
    )

    await materializer.materialize((MagicMock(path=repository),), tmp_path / "workspace")

    assert sorted(entry.name for entry in destination.iterdir()) == ["kept"]
    log.warn.assert_called_once_with(
        "managed_skills.collisions_dropped",
        collisions=[
            {"name": "alias", "paths": [str(alias_discovered)]},
            {"name": "bundled", "paths": [str(bundled_discovered)]},
            {"name": "conflict", "paths": [str(discovered)]},
        ],
    )


async def test_materializer_ignores_invalid_utf8_during_collision_scan(tmp_path):
    document = _installation()
    client = MagicMock()
    client.fetch_installation = AsyncMock(return_value=json.dumps(document).encode())
    bundled = tmp_path / "bundled" / "unrelated"
    bundled.mkdir(parents=True)
    (bundled / "SKILL.md").write_bytes(b"---\nname: \xff\n---\n")
    destination = tmp_path / "global" / "skills"
    materializer = ManagedSkillsMaterializer(
        client,
        destination,
        MagicMock(),
        bundled_skills_path=tmp_path / "bundled",
    )

    await materializer.materialize((), tmp_path / "workspace")

    assert (destination / "managed" / "SKILL.md").exists()


def _page(names, *, next_cursor=None, manifest_sha256="a" * 64):
    """A response carrying `names` as one page of a wider installation."""
    document = {
        "schemaVersion": 1,
        "manifestSha256": manifest_sha256,
        "skills": [_installation(name=name)["skills"][0] for name in names],
        "nextCursor": next_cursor,
    }
    return json.dumps(document).encode()


async def test_materializer_installs_every_page(tmp_path):
    pages = [
        _page(["alpha", "beta"], next_cursor="1"),
        _page(["gamma"], next_cursor="2"),
        _page(["delta"]),
    ]
    client = MagicMock()
    client.fetch_installation = AsyncMock(side_effect=pages)
    destination = tmp_path / "global" / "skills"
    materializer = ManagedSkillsMaterializer(
        client,
        destination,
        MagicMock(),
        bundled_skills_path=tmp_path / "missing-bundled",
    )

    await materializer.materialize((), tmp_path / "workspace")

    assert sorted(entry.name for entry in destination.iterdir()) == [
        "alpha",
        "beta",
        "delta",
        "gamma",
    ]
    # Every request must carry a page size, and each one resumes from the
    # previous response's cursor.
    assert [call.kwargs for call in client.fetch_installation.await_args_list] == [
        {"cursor": None, "limit": 50},
        {"cursor": "1", "limit": 50},
        {"cursor": "2", "limit": 50},
    ]


async def test_materializer_keeps_previous_install_when_a_later_page_fails(tmp_path):
    client = MagicMock()
    client.fetch_installation = AsyncMock(
        side_effect=[
            _page(["alpha"], next_cursor="1"),
            ManagedSkillsError("boom", code="fetch_failed"),
        ]
    )
    destination = tmp_path / "global" / "skills"
    destination.mkdir(parents=True)
    (destination / "previous").mkdir()
    materializer = ManagedSkillsMaterializer(
        client,
        destination,
        MagicMock(),
        bundled_skills_path=tmp_path / "missing-bundled",
    )

    with pytest.raises(ManagedSkillsError, match="boom"):
        await materializer.materialize((), tmp_path / "workspace")

    # A partial fetch must never be swapped in: the tree is all-or-nothing.
    assert [entry.name for entry in destination.iterdir()] == ["previous"]
    assert not (tmp_path / "global" / ".managed-skills-staging").exists()


async def test_materializer_rejects_pages_from_different_manifests(tmp_path):
    client = MagicMock()
    client.fetch_installation = AsyncMock(
        side_effect=[
            _page(["alpha"], next_cursor="1"),
            _page(["beta"], manifest_sha256="b" * 64),
        ]
    )
    materializer = ManagedSkillsMaterializer(
        client,
        tmp_path / "global" / "skills",
        MagicMock(),
        bundled_skills_path=tmp_path / "missing-bundled",
    )

    with pytest.raises(ManagedSkillsError, match="different manifests"):
        await materializer.materialize((), tmp_path / "workspace")


async def test_materializer_rejects_duplicate_names_across_pages(tmp_path):
    client = MagicMock()
    client.fetch_installation = AsyncMock(
        side_effect=[_page(["alpha"], next_cursor="1"), _page(["alpha"])]
    )
    materializer = ManagedSkillsMaterializer(
        client,
        tmp_path / "global" / "skills",
        MagicMock(),
        bundled_skills_path=tmp_path / "missing-bundled",
    )

    with pytest.raises(ManagedSkillsError, match="duplicate managed skill name"):
        await materializer.materialize((), tmp_path / "workspace")


async def test_materializer_rejects_an_empty_page_that_claims_more(tmp_path):
    """A page promising more must deliver something, or traversal cannot terminate."""
    client = MagicMock()
    client.fetch_installation = AsyncMock(
        side_effect=lambda **_: _page([], next_cursor="always-more")
    )
    materializer = ManagedSkillsMaterializer(
        client,
        tmp_path / "global" / "skills",
        MagicMock(),
        bundled_skills_path=tmp_path / "missing-bundled",
    )

    with pytest.raises(ManagedSkillsError, match="empty but claims more"):
        await materializer.materialize((), tmp_path / "workspace")


async def test_materializer_traversal_is_not_capped_by_a_page_count(tmp_path):
    """Installation width is bounded by aggregate content, never by a page count."""
    total = 1010
    pages = [
        _page([f"skill-{index:04d}"], next_cursor=None if index == total - 1 else str(index))
        for index in range(total)
    ]
    client = MagicMock()
    client.fetch_installation = AsyncMock(side_effect=pages)
    destination = tmp_path / "global" / "skills"
    materializer = ManagedSkillsMaterializer(
        client,
        destination,
        MagicMock(),
        bundled_skills_path=tmp_path / "missing-bundled",
    )

    await materializer.materialize((), tmp_path / "workspace")

    assert len(list(destination.iterdir())) == total
    assert client.fetch_installation.await_count == total


def test_validate_installation_rejects_a_page_read_as_a_whole():
    with pytest.raises(ManagedSkillsError, match="paged"):
        validate_installation(_page(["alpha"], next_cursor="1"))


def test_materializer_repairs_interrupted_swap(tmp_path):
    destination = tmp_path / "skills"
    backup = tmp_path / ".managed-skills-backup"
    staging = tmp_path / ".managed-skills-staging"
    journal = tmp_path / ".managed-skills-swap"
    backup.mkdir()
    staging.mkdir()
    (backup / "previous").write_text("ok")
    journal.write_text("")
    materializer = ManagedSkillsMaterializer(MagicMock(), destination, MagicMock())

    materializer._repair_interrupted_swap(staging, backup, journal)

    assert (destination / "previous").read_text() == "ok"
    assert not staging.exists()
    assert not journal.exists()


def test_materializer_repairs_interrupted_swap_after_destination_install(tmp_path):
    destination = tmp_path / "skills"
    backup = tmp_path / ".managed-skills-backup"
    staging = tmp_path / ".managed-skills-staging"
    journal = tmp_path / ".managed-skills-swap"
    destination.mkdir()
    backup.mkdir()
    staging.mkdir()
    (destination / "current").write_text("new")
    (backup / "previous").write_text("old")
    journal.write_text("")
    materializer = ManagedSkillsMaterializer(MagicMock(), destination, MagicMock())

    materializer._repair_interrupted_swap(staging, backup, journal)

    assert (destination / "current").read_text() == "new"
    assert not backup.exists()
    assert not staging.exists()
    assert not journal.exists()


@pytest.mark.parametrize(
    ("control_plane_url", "session_config"),
    [
        ("", '{"session_id":"session-1"}'),
        ("https://control.example", "{}"),
    ],
)
def test_supervisor_skips_managed_skills_without_endpoint(
    control_plane_url, session_config, tmp_path
):
    environment = {
        "CONTROL_PLANE_URL": control_plane_url,
        "HOME": str(tmp_path / "home"),
        "SESSION_CONFIG": session_config,
    }

    with patch.dict("os.environ", environment, clear=True):
        supervisor = build_supervisor(asyncio.Event())

    assert supervisor.managed_skills is None


@pytest.mark.parametrize("config_variable", ["OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME"])
def test_supervisor_derives_managed_skill_paths_from_global_config(config_variable, tmp_path):
    configured_path = tmp_path / "custom"
    config_dir = (
        configured_path
        if config_variable == "OPENCODE_CONFIG_DIR"
        else configured_path / "opencode"
    )
    environment = {
        "CONTROL_PLANE_URL": "https://control.example",
        "SESSION_CONFIG": '{"session_id":"session-1"}',
        config_variable: str(configured_path),
    }

    with patch.dict("os.environ", environment, clear=True):
        supervisor = build_supervisor(asyncio.Event())

    materializer = supervisor.managed_skills
    assert materializer is not None
    assert materializer.destination == config_dir / "skills"

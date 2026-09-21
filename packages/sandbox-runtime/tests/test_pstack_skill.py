"""Structural checks for the bundled OpenInspect pstack adaptation."""

import re
from pathlib import Path

PSTACK = Path(__file__).resolve().parents[1] / "src" / "sandbox_runtime" / "skills" / "pstack"
FORBIDDEN_CURSOR_CONTRACTS = (
    ".cursor/",
    "cursor-team-kit",
    "run_in_background",
    "cloud_base_branch",
    'environment: "cloud"',
    "subagent_type",
)


def test_pstack_is_a_single_namespaced_bundled_skill() -> None:
    skill = (PSTACK / "SKILL.md").read_text()

    assert "name: pstack" in skill
    assert (PSTACK / "LICENSE.pstack").read_text().startswith("MIT License")
    assert len(list((PSTACK / "workflows").glob("*.md"))) == 8
    assert len(list((PSTACK / "principles").glob("*.md"))) == 23


def test_pstack_uses_openinspect_orchestration_contracts() -> None:
    markdown = "\n".join(path.read_text() for path in PSTACK.rglob("*.md"))

    for contract in FORBIDDEN_CURSOR_CONTRACTS:
        assert contract not in markdown
    assert "spawn-child" in markdown
    assert "wait-for-children" in markdown
    assert "send-child-prompt" in markdown


def test_every_relative_markdown_link_resolves() -> None:
    failures: list[str] = []
    for document in PSTACK.rglob("*.md"):
        for target in re.findall(r"\]\(([^)]+)\)", document.read_text()):
            path = target.split("#", 1)[0]
            if not path or "://" in path:
                continue
            if not (document.parent / path).resolve().exists():
                failures.append(f"{document.relative_to(PSTACK)} -> {target}")

    assert failures == []

from src.web_api import parse_git_numstat, parse_git_status_porcelain


def test_parse_git_status_porcelain_basic():
    output = "\n".join(
        [
            " M packages/web/src/app.tsx",
            "A  packages/web/src/new.ts",
            "D  packages/web/src/old.ts",
            "R  packages/web/src/a.ts -> packages/web/src/b.ts",
            "?? packages/web/src/untracked.ts",
        ]
    )

    parsed = parse_git_status_porcelain(output)

    assert parsed == [
        {
            "filename": "packages/web/src/app.tsx",
            "old_filename": None,
            "status": "modified",
        },
        {
            "filename": "packages/web/src/new.ts",
            "old_filename": None,
            "status": "added",
        },
        {
            "filename": "packages/web/src/old.ts",
            "old_filename": None,
            "status": "deleted",
        },
        {
            "filename": "packages/web/src/b.ts",
            "old_filename": "packages/web/src/a.ts",
            "status": "renamed",
        },
        {
            "filename": "packages/web/src/untracked.ts",
            "old_filename": None,
            "status": "untracked",
        },
    ]


def test_parse_git_numstat_basic():
    output = "\n".join(
        [
            "12\t3\tpackages/web/src/app.tsx",
            "7\t0\tpackages/web/src/new.ts",
            "-\t-\tpackages/web/src/renamed.ts",
        ]
    )

    parsed = parse_git_numstat(output)

    assert parsed == {
        "packages/web/src/app.tsx": {"additions": 12, "deletions": 3},
        "packages/web/src/new.ts": {"additions": 7, "deletions": 0},
        "packages/web/src/renamed.ts": {"additions": 0, "deletions": 0},
    }

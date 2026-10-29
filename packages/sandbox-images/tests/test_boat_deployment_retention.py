"""Worker deployment history, not artifact age, determines Boat rollback retention."""

import io
import json
import runpy
import urllib.error
import urllib.request
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, call

import pytest

ROOT = Path(__file__).resolve().parents[3]
PREFIX = "base"
A, B, C, D = (f"{PREFIX}-{digit * 16}" for digit in "abcd")
API_URL = "https://boat.example.test/api/v1"
ORG = "test-org"
CURRENT = ("boat", API_URL, ORG, C)
DEPLOYMENTS_PATH = "/deployments?per_page=100&page=1"
CF_BASE_URL = (
    "https://api.cloudflare.com/client/v4/accounts/account%2Fid/workers/scripts/worker%2Fname"
)
TOKEN = "cloudflare_test_token"


def version_envelope(version_id, snapshot, **overrides):
    bindings = {
        "SANDBOX_PROVIDER": "boat",
        "BOAT_API_URL": f"{API_URL}/",
        "BOAT_ORG": ORG,
        "BOAT_BASE_SNAPSHOT": snapshot,
        **overrides,
    }
    return {
        "success": True,
        "result": {
            "id": version_id,
            "resources": {
                "bindings": [
                    {"name": name, "type": "plain_text", "text": text}
                    for name, text in bindings.items()
                ]
            },
        },
    }


def history(*snapshots):
    """Accept chronological bases and serve independent Cloudflare GET envelopes."""
    deployments = [
        {
            "id": f"deployment-{index}",
            "created_on": f"2026-01-01T00:{index // 60:02d}:{index % 60:02d}+00:00",
            "versions": [{"version_id": f"version-{index}", "percentage": 100}],
        }
        for index in range(len(snapshots), 0, -1)
    ]
    responses = {
        DEPLOYMENTS_PATH: {
            "success": True,
            "result": {"deployments": deployments},
            "result_info": {"total_pages": 1},
        },
        **{
            f"/versions/version-{index}": version_envelope(f"version-{index}", snapshot)
            for index, snapshot in enumerate(snapshots, 1)
        },
    }
    get = Mock(side_effect=lambda path: deepcopy(responses[path]))
    return deployments[0]["id"], responses, get


@pytest.fixture(autouse=True)
def block_live_requests(monkeypatch):
    monkeypatch.setattr(
        urllib.request.OpenerDirector,
        "open",
        Mock(side_effect=AssertionError("unexpected live request")),
    )


@pytest.fixture
def script():
    return runpy.run_path(str(ROOT / "packages/boat-infra/prune-deployed-snapshots.py"))


@pytest.fixture
def builder():
    return runpy.run_path(str(ROOT / "packages/boat-infra/build-template.py"))


@pytest.fixture
def main_setup(monkeypatch, script, builder):
    def configure(get, deployment_id):
        environ = {
            "BOAT_API_URL": f"{API_URL}/",
            "BOAT_ORG": ORG,
            "BOAT_BASE_SNAPSHOT": PREFIX,
            "BOAT_DEPLOYED_SNAPSHOT": C,
            "BOAT_REPLACED_SNAPSHOT": "stale-reference",
            "CLOUDFLARE_API_TOKEN": TOKEN,
            "CLOUDFLARE_ACCOUNT_ID": "account/id",
            "CLOUDFLARE_WORKER_NAME": "worker/name",
            "CLOUDFLARE_DEPLOYMENT_ID": deployment_id,
        }
        handoffs = []
        prune = Mock(
            side_effect=lambda argv: handoffs.append((argv, environ["BOAT_REPLACED_SNAPSHOT"]))
        )

        def open_response(request, *, timeout):
            assert request.get_method() == "GET"
            assert request.full_url.startswith(f"{CF_BASE_URL}/")
            assert request.get_header("Authorization") == f"Bearer {TOKEN}"
            assert timeout == builder["REQUEST_TIMEOUT_SECONDS"]
            return io.BytesIO(json.dumps(get(request.full_url.removeprefix(CF_BASE_URL))).encode())

        opener = Mock(side_effect=open_response)
        fake_builder = {**builder, "OPENER": SimpleNamespace(open=opener), "main": prune}
        globals_ = script["main"].__globals__
        # Replace this module's reference, not the shared runpy.run_path function.
        monkeypatch.setitem(globals_, "runpy", SimpleNamespace(run_path=lambda _: fake_builder))
        monkeypatch.setitem(globals_, "os", SimpleNamespace(environ=environ))
        return SimpleNamespace(
            main=script["main"], environ=environ, opener=opener, prune=prune, handoffs=handoffs
        )

    return configure


def test_redeployment_prune_keeps_last_deployed_base_not_newer_undeployed_artifact(script, builder):
    deployment_id, _, get = history(A, B, A, C)
    replaced = script["replaced_snapshot"](get, deployment_id, CURRENT, PREFIX)
    assert replaced == A

    snapshots = [
        {"name": name, "status": "ready", "createdAt": f"2026-01-{day:02d}T00:00:00Z"}
        for day, name in enumerate((A, B, C, D), 1)
    ]
    request = Mock(
        side_effect=[
            {"snapshots": snapshots},
            {},
            {},
            {"snapshots": [snapshots[0], snapshots[2]]},
        ]
    )

    builder["prune_snapshots"](SimpleNamespace(request=request), PREFIX, C, replaced, dry_run=False)

    assert request.call_args_list == [
        call("GET", "/saved-snapshots"),
        call("DELETE", f"/saved-snapshots/{B}"),
        call("DELETE", f"/saved-snapshots/{D}"),
        call("GET", "/saved-snapshots"),
    ]


@pytest.mark.parametrize(
    ("snapshots", "expected"),
    [((A, B, A), B), ((A, C, C), A)],
    ids=["revert", "unchanged-base-retry"],
)
def test_revert_and_retry_retain_last_distinct_base(script, snapshots, expected):
    deployment_id, _, get = history(*snapshots)

    current = (*CURRENT[:3], snapshots[-1])
    assert script["replaced_snapshot"](get, deployment_id, current, PREFIX) == expected


def test_history_reads_predecessor_beyond_first_page(script):
    deployment_id, responses, get = history(A, *([C] * 100))
    deployments = responses[DEPLOYMENTS_PATH]["result"]["deployments"]
    responses[DEPLOYMENTS_PATH]["result"]["deployments"] = deployments[:100]
    responses[DEPLOYMENTS_PATH]["result_info"]["total_pages"] = 2
    second_page = "/deployments?per_page=100&page=2"
    responses[second_page] = {"success": True, "result": {"deployments": deployments[100:]}}

    assert script["replaced_snapshot"](get, deployment_id, CURRENT, PREFIX) == A

    assert get.call_args_list == [
        call(DEPLOYMENTS_PATH),
        call(second_page),
        *(call(f"/versions/version-{index}") for index in range(101, 0, -1)),
        call(DEPLOYMENTS_PATH),
    ]


def test_full_page_without_pagination_metadata_fails_closed(script):
    deployment_id, responses, get = history(*([C] * 100))
    del responses[DEPLOYMENTS_PATH]["result_info"]

    with pytest.raises(RuntimeError, match="pagination is unknown"):
        script["replaced_snapshot"](get, deployment_id, CURRENT, PREFIX)

    assert get.call_args_list == [call(DEPLOYMENTS_PATH)]


@pytest.mark.parametrize("failure", ["split", "ambiguous", "equivalent-times", "duplicate-id"])
def test_unsafe_deployment_history_fails_closed(script, failure):
    deployment_id, responses, get = history(A, C)
    deployments = responses[DEPLOYMENTS_PATH]["result"]["deployments"]
    if failure == "split":
        deployments[1]["versions"] = [
            {"version_id": "version-1", "percentage": 50},
            {"version_id": "canary", "percentage": 50},
        ]
        message = "split Worker deployment"
    elif failure == "duplicate-id":
        deployments[1]["id"] = deployments[0]["id"]
        message = "order is ambiguous"
    else:
        deployments[1]["created_on"] = (
            "2026-01-01T01:00:02+01:00"
            if failure == "equivalent-times"
            else deployments[0]["created_on"]
        )
        message = "order is ambiguous"

    with pytest.raises(RuntimeError, match=message):
        script["replaced_snapshot"](get, deployment_id, CURRENT, PREFIX)


def test_expected_deployment_must_be_active(script):
    _, _, get = history(A, C)

    with pytest.raises(RuntimeError, match="expected Worker deployment is not active"):
        script["replaced_snapshot"](get, "other-deployment", CURRENT, PREFIX)

    assert get.call_args_list == [call(DEPLOYMENTS_PATH)]


def test_incomplete_deployment_pages_fail_closed(script):
    deployment_id, responses, get = history(A, C)
    responses[DEPLOYMENTS_PATH]["result_info"]["total_pages"] = 2
    with pytest.raises(RuntimeError, match="history is incomplete"):
        script["replaced_snapshot"](get, deployment_id, CURRENT, PREFIX)


@pytest.mark.parametrize(
    ("binding", "value"),
    [
        ("BOAT_BASE_SNAPSHOT", B),
        ("BOAT_API_URL", "https://other.example.test/api/v1"),
        ("BOAT_ORG", "other-org"),
    ],
)
def test_active_bindings_must_match_expected_scope(script, binding, value):
    deployment_id, responses, get = history(A, C)
    responses["/versions/version-2"] = version_envelope("version-2", C, **{binding: value})

    with pytest.raises(RuntimeError, match="bindings do not match Terraform"):
        script["replaced_snapshot"](get, deployment_id, CURRENT, PREFIX)

    assert get.call_args_list == [call(DEPLOYMENTS_PATH), call("/versions/version-2")]


def test_active_deployment_change_on_final_recheck_prevents_pruning(main_setup):
    deployment_id, responses, get = history(A, C)
    changed = deepcopy(responses[DEPLOYMENTS_PATH])
    changed["result"]["deployments"][0]["id"] = "new-deployment"
    get.side_effect = [
        responses[DEPLOYMENTS_PATH],
        responses["/versions/version-2"],
        responses["/versions/version-1"],
        changed,
    ]
    context = main_setup(get, deployment_id)

    with pytest.raises(RuntimeError, match="Worker changed while reading history"):
        context.main([])

    context.prune.assert_not_called()
    assert get.call_args_list == [
        call(DEPLOYMENTS_PATH),
        call("/versions/version-2"),
        call("/versions/version-1"),
        call(DEPLOYMENTS_PATH),
    ]


@pytest.mark.parametrize("snapshots", [(C,), (C, C)], ids=["unknown", "no-distinct-base"])
def test_unproven_predecessor_returns_none_and_skips_all_boat_calls(
    script, main_setup, capsys, snapshots
):
    deployment_id, _, get = history(*snapshots)
    assert script["replaced_snapshot"](get, deployment_id, CURRENT, PREFIX) is None
    context = main_setup(get, deployment_id)

    context.main([])

    context.prune.assert_not_called()
    assert context.environ["BOAT_REPLACED_SNAPSHOT"] == "stale-reference"
    assert "skipping Boat pruning" in capsys.readouterr().out


@pytest.mark.parametrize(
    ("binding", "value", "expected"),
    [
        ("BOAT_API_URL", "https://other.example.test/api/v1", ""),
        ("BOAT_ORG", "other-org", ""),
        ("BOAT_BASE_SNAPSHOT", "other-bbbbbbbbbbbbbbbb", ""),
        ("SANDBOX_PROVIDER", "modal", ""),
        ("BOAT_BASE_SNAPSHOT", B, B),
    ],
    ids=["api", "org", "prefix", "provider", "same-scope"],
)
def test_first_different_state_is_a_history_boundary(script, binding, value, expected):
    deployment_id, responses, get = history(A, B, C)
    responses["/versions/version-2"] = version_envelope("version-2", B, **{binding: value})

    assert script["replaced_snapshot"](get, deployment_id, CURRENT, PREFIX) == expected

    # An older base in the current scope must not be selected across this boundary.
    assert get.call_args_list == [
        call(DEPLOYMENTS_PATH),
        call("/versions/version-3"),
        call("/versions/version-2"),
        call(DEPLOYMENTS_PATH),
    ]


@pytest.mark.parametrize("missing", ["deployments", "versions", "resources", "BOAT_BASE_SNAPSHOT"])
def test_missing_history_or_version_fields_prevent_pruning(main_setup, missing):
    deployment_id, responses, get = history(A, C)
    if missing == "deployments":
        del responses[DEPLOYMENTS_PATH]["result"]["deployments"]
    elif missing == "versions":
        del responses[DEPLOYMENTS_PATH]["result"]["deployments"][0]["versions"]
    elif missing == "resources":
        del responses["/versions/version-2"]["result"]["resources"]
    else:
        resources = responses["/versions/version-2"]["result"]["resources"]
        resources["bindings"] = [
            binding for binding in resources["bindings"] if binding["name"] != missing
        ]
    context = main_setup(get, deployment_id)

    with pytest.raises(KeyError, match=missing):
        context.main([])

    context.prune.assert_not_called()
    assert context.environ["BOAT_REPLACED_SNAPSHOT"] == "stale-reference"


@pytest.mark.parametrize(
    ("dry_run", "previous_org", "expected"),
    [(False, ORG, A), (True, ORG, A), (False, "other-org", "")],
    ids=["prune", "dry-run", "scope-transition"],
)
def test_main_passes_confirmed_predecessor_and_prune_arguments(
    main_setup, dry_run, previous_org, expected
):
    deployment_id, responses, get = history(A, C)
    responses["/versions/version-1"] = version_envelope("version-1", A, BOAT_ORG=previous_org)
    context = main_setup(get, deployment_id)

    context.main(["--dry-run"] if dry_run else [])

    expected_args = ["prune", "--dry-run"] if dry_run else ["prune"]
    context.prune.assert_called_once_with(expected_args)
    assert context.handoffs == [(expected_args, expected)]
    assert context.environ["BOAT_REPLACED_SNAPSHOT"] == expected


@pytest.mark.parametrize("prefix", ["oi-img", "oi-img-base"])
def test_main_rejects_reserved_namespace_before_cloudflare_lookup(main_setup, prefix):
    deployment_id, _, get = history(A, C)
    context = main_setup(get, deployment_id)
    context.environ["BOAT_BASE_SNAPSHOT"] = prefix

    with pytest.raises(RuntimeError, match="reserved for prebuilt images"):
        context.main([])

    context.opener.assert_not_called()
    context.prune.assert_not_called()


def test_missing_cloudflare_token_prevents_all_provider_calls(main_setup):
    deployment_id, _, get = history(A, C)
    context = main_setup(get, deployment_id)
    del context.environ["CLOUDFLARE_API_TOKEN"]

    with pytest.raises(KeyError, match="CLOUDFLARE_API_TOKEN"):
        context.main([])

    context.opener.assert_not_called()
    context.prune.assert_not_called()


@pytest.mark.parametrize("failure", ["success-false", "http-error"])
def test_cloudflare_errors_are_sanitized_and_prevent_pruning(main_setup, capsys, failure):
    deployment_id, responses, get = history(A, C)
    if failure == "success-false":
        responses[DEPLOYMENTS_PATH] = {"success": False, "errors": [{"message": TOKEN}]}
        message = "Cloudflare deployment lookup failed; nothing was deleted"
    else:
        get.side_effect = urllib.error.HTTPError(
            f"{CF_BASE_URL}{DEPLOYMENTS_PATH}", 403, TOKEN, None, io.BytesIO(TOKEN.encode())
        )
        message = "Cloudflare deployment lookup failed: API 403"
    context = main_setup(get, deployment_id)

    with pytest.raises(RuntimeError) as raised:
        context.main([])

    assert str(raised.value) == message
    assert TOKEN not in str(raised.value)
    output = capsys.readouterr()
    assert TOKEN not in output.out + output.err
    context.prune.assert_not_called()
    assert get.call_args_list == [call(DEPLOYMENTS_PATH)]

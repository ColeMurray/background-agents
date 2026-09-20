"""Sandbox0 publishes only verified captures and never destroys a pending source."""

import runpy
from pathlib import Path
from unittest.mock import Mock

import pytest

from sandbox_images import bundle, native

ROOT = Path(__file__).parents[3]


@pytest.fixture
def adapter(monkeypatch, tmp_path):
    """Run the real builder orchestration with isolated API, bundle, and publication doubles."""
    namespace = runpy.run_path(str(ROOT / "packages/sandbox0-infra/build-template.py"))
    main = namespace["main"]
    client = Mock()
    client.create.side_effect = ["builder", "probe"]
    client.request.return_value = {"status": {"creation": {"state": "ready"}}}
    packed = tmp_path / "bundle"
    packed.mkdir()
    plan = {
        "buildHash": "a" * 64,
        "target": {"base": "default"},
        "runtimeEnv": {"HOME": "/root"},
        "runtimeVersion": "v-test",
    }
    monkeypatch.setitem(main.__globals__, "Client", lambda: client)
    monkeypatch.setitem(
        main.__globals__, "pack_bundle", Mock(return_value=bundle.PackedBundle(packed, plan))
    )
    publish = Mock()
    monkeypatch.setitem(main.__globals__, "write_build_result", publish)
    monkeypatch.delenv("OPENINSPECT_IMAGE_CANDIDATE", raising=False)
    return main, client, publish


def test_only_publishes_after_verifying_a_fresh_claim(adapter):
    """A ready capture is insufficient: publish its reference only after a fresh guest verifies it."""
    main, client, publish = adapter
    client.command.side_effect = lambda *_args, **_kwargs: publish.assert_not_called()
    main()
    candidate = publish.call_args.args[0]
    assert candidate.startswith("openinspect-aaaaaaaaaaaa-")
    assert client.create.call_args_list[1].args == (candidate,)
    client.command.assert_called_with(
        "probe",
        ["/opt/openinspect/python/bin/python", "/app/verify/smoke_test.py", "verify"],
        timeout=600,
    )
    assert [call.args[0] for call in client.delete.call_args_list] == ["probe", "builder"]


def test_failed_verification_cleans_resources_without_publishing(adapter):
    """A failed probe must release both owned guests without advertising a usable artifact."""
    main, client, publish = adapter
    client.command.side_effect = [None, RuntimeError("verification failed")]
    with pytest.raises(RuntimeError, match="verification failed"):
        main()
    publish.assert_not_called()
    assert client.delete.call_count == 2


def test_ambiguous_capture_preserves_its_source(adapter):
    """A lost capture response cannot prove the source is safe to delete."""
    main, client, publish = adapter
    client.request.side_effect = [None, TimeoutError("capture request timed out")]
    with pytest.raises(TimeoutError):
        main()
    client.delete.assert_not_called()
    publish.assert_not_called()


def test_retry_verifies_retained_candidate_without_overwriting_it(adapter, monkeypatch):
    """Retrying a retained capture verifies it read-only and cleans up only the new probe."""
    main, client, publish = adapter
    monkeypatch.setenv("OPENINSPECT_IMAGE_CANDIDATE", "retained")
    client.create.side_effect = ["probe"]
    main()
    client.create.assert_called_once_with("retained")
    client.delete.assert_called_once_with("probe")
    assert all(call.args[0] == "GET" for call in client.request.call_args_list)
    publish.assert_called_once_with("retained")


def test_native_command_dispatches_sandbox0_builder(monkeypatch, tmp_path):
    """The shared dispatcher must receive the builder's verified reference via its result file."""
    monkeypatch.setattr(native, "update_locks", Mock())

    def run(command, *, cwd, env, check):
        """Emulate only the subprocess result-file contract, without allocating a live guest."""
        assert cwd == tmp_path
        assert check
        assert command[1] == "packages/sandbox0-infra/build-template.py"
        Path(env["OPENINSPECT_IMAGE_RESULT"]).write_text('{"reference":"verified"}')

    monkeypatch.setattr(native.subprocess, "run", run)
    assert native.build_image(tmp_path, "sandbox0") == {"reference": "verified"}

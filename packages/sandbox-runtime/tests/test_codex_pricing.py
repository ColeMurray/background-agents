import asyncio
import json
import os
import time
from unittest.mock import Mock, create_autospec

import httpx
import pytest

from sandbox_runtime.harness.codex import pricing
from sandbox_runtime.log_config import StructuredLogger


def model(**cost):
    return {"cost": {"input": 2, "output": 8, "cache_read": 0.5, "cache_write": 3, **cost}}


def usage(**counts):
    return {
        "inputTokens": 100,
        "cachedInputTokens": 20,
        "cacheWriteInputTokens": 10,
        "outputTokens": 40,
        "reasoningOutputTokens": 30,
        **counts,
    }


def test_disjoint_cache_and_reasoning_are_not_double_counted():
    assert pricing.price_codex_usage(model(), usage()) == pytest.approx(
        (70 * 2 + 20 * 0.5 + 10 * 3 + 40 * 8) / 1_000_000
    )


@pytest.mark.parametrize("input_tokens,rate", [(100, 2), (101, 4), (200, 4), (201, 6)])
def test_unsorted_tiers_have_strict_boundaries_and_include_cached_input(input_tokens, rate):
    tiers = [
        {**model(input=6)["cost"], "tier": {"type": "context", "size": 200}},
        {**model(input=4)["cost"], "tier": {"type": "context", "size": 100}},
    ]
    counts = usage(inputTokens=input_tokens, outputTokens=0, reasoningOutputTokens=0)
    assert pricing.price_codex_usage(model(tiers=tiers), counts) == pytest.approx(
        ((input_tokens - 30) * rate + 20 * 0.5 + 10 * 3) / 1_000_000
    )


@pytest.mark.parametrize("unknown_model", [None, {}, {"cost": {"input": False}}])
def test_explicit_zero_usage_is_known_even_with_unknown_model(unknown_model):
    assert pricing.price_codex_usage(unknown_model, {"inputTokens": 0, "outputTokens": 0}) == 0
    assert pricing.price_codex_usage(unknown_model, {}) is None
    assert pricing.price_codex_usage(unknown_model, usage()) is None


def test_zero_rates_are_valid():
    assert (
        pricing.price_codex_usage(model(input=0, output=0, cache_read=0, cache_write=0), usage())
        == 0
    )


@pytest.mark.parametrize("field", ["input", "output", "cache_read", "cache_write"])
@pytest.mark.parametrize("rate", [None, True, False, "2", -1, float("inf"), float("nan"), 10**400])
def test_invalid_rates_fail_safe(field, rate):
    assert pricing.price_codex_usage(model(**{field: rate}), usage()) is None


@pytest.mark.parametrize("field", ["input", "output"])
def test_missing_base_rates_are_unknown_even_for_unused_bucket(field):
    entry = model()
    del entry["cost"][field]
    assert pricing.price_codex_usage(entry, {"inputTokens": 1, "outputTokens": 0}) is None


@pytest.mark.parametrize(
    "rate,count", [("cache_read", "cachedInputTokens"), ("cache_write", "cacheWriteInputTokens")]
)
def test_missing_optional_rate_only_allowed_for_zero_bucket(rate, count):
    entry = model()
    del entry["cost"][rate]
    assert pricing.price_codex_usage(entry, usage()) is None
    assert pricing.price_codex_usage(entry, usage(**{count: 0})) is not None


def test_tiers_do_not_inherit_missing_cache_rates_from_base():
    entry = model(tiers=[{"input": 4, "output": 8, "tier": {"type": "context", "size": 0}}])
    assert pricing.price_codex_usage(entry, usage()) is None
    assert pricing.price_codex_usage(
        entry, {"inputTokens": 100, "outputTokens": 0}
    ) == pytest.approx(0.0004)


def test_selected_tier_applies_to_all_rates_and_does_not_hide_invalid_base():
    entry = model(
        tiers=[
            {
                "input": 4,
                "output": 16,
                "cache_read": 1,
                "cache_write": 6,
                "tier": {"type": "context", "size": 0},
            }
        ]
    )
    assert pricing.price_codex_usage(entry, usage()) == pytest.approx(
        (70 * 4 + 20 + 10 * 6 + 40 * 16) / 1_000_000
    )
    del entry["cost"]["input"]
    assert pricing.price_codex_usage(entry, usage()) is None


@pytest.mark.parametrize(
    "tiers",
    [
        None,
        {},
        [None],
        [{"input": 2, "output": 8}],
        [{"input": 2, "output": 8, "tier": {"type": "other", "size": 10}}],
        [{"input": 2, "output": 8, "tier": {"type": "context", "size": True}}],
        [{"input": 2, "output": 8, "tier": {"type": "context", "size": -1}}],
        [{"input": 2, "output": 8, "tier": {"type": "context", "size": float("inf")}}],
        [{"input": None, "output": 8, "tier": {"type": "context", "size": 1000}}],
        [{"input": 2, "output": 8, "tier": {"type": "context", "size": 10}}] * 2,
    ],
)
def test_malformed_or_ambiguous_tiers_are_unknown(tiers):
    assert (
        pricing.price_codex_usage(model(tiers=tiers), {"inputTokens": 1, "outputTokens": 0}) is None
    )


def test_legacy_threshold_is_not_guessed_but_explicit_tiers_take_precedence():
    entry = model(context_over_200k={"input": 20, "output": 80})
    assert pricing.price_codex_usage(entry, usage()) is None
    entry["cost"]["tiers"] = [{**model()["cost"], "tier": {"type": "context", "size": 1000}}]
    assert pricing.price_codex_usage(entry, usage()) == pricing.price_codex_usage(model(), usage())


def test_huge_rates_do_not_overflow_before_per_million_scaling():
    assert pricing.price_codex_usage(
        model(input=1e308), {"inputTokens": 100, "outputTokens": 0}
    ) == pytest.approx(1e304)
    assert (
        pricing.price_codex_usage(model(input=1e308), {"inputTokens": 10**9, "outputTokens": 0})
        is None
    )
    assert pricing.price_codex_usage(model(), {"inputTokens": 10**400, "outputTokens": 0}) is None


@pytest.mark.parametrize(
    "counts",
    [
        {},
        {"inputTokens": 0},
        usage(inputTokens=True),
        usage(outputTokens=-1),
        usage(cachedInputTokens=1.5),
        usage(cacheWriteInputTokens=-1),
        usage(cachedInputTokens=91),
        usage(reasoningOutputTokens=41),
        usage(inputTokens=0, outputTokens=0),
    ],
)
def test_invalid_or_missing_counts_are_unknown(counts):
    assert pricing.price_codex_usage(model(), counts) is None


@pytest.fixture(autouse=True)
def mock_network(monkeypatch):
    handler = Mock(side_effect=AssertionError("Unexpected network request"))
    client = httpx.AsyncClient
    monkeypatch.setattr(
        pricing.httpx,
        "AsyncClient",
        lambda **kwargs: client(transport=httpx.MockTransport(handler), **kwargs),
    )
    return handler


@pytest.fixture
def cache(tmp_path):
    path = tmp_path / "opencode" / "models.json"
    path.parent.mkdir()
    path.write_bytes(catalog_bytes())
    return path


def catalog_bytes(input_rate=2):
    return json.dumps(
        {"openai": {"models": {"test-model": model(input=input_rate)}}, "other": {"models": {}}}
    ).encode()


def make_stale(path):
    stale = time.time() - pricing.CATALOG_TTL_SECONDS - 10
    os.utime(path, (stale, stale))


async def test_fresh_cache_is_an_independent_snapshot(cache, mock_network):
    env = {"XDG_CACHE_HOME": str(cache.parent.parent)}
    first = await pricing.load_codex_pricing(env, Mock())
    first["test-model"]["cost"]["input"] = 99
    second = await pricing.load_codex_pricing(env, Mock())
    assert second == {"test-model": model()}
    mock_network.assert_not_called()


async def test_home_cache_fallback(tmp_path, monkeypatch, mock_network):
    path = tmp_path / ".cache" / "opencode" / "models.json"
    path.parent.mkdir(parents=True)
    path.write_bytes(catalog_bytes())
    assert await pricing.load_codex_pricing({"HOME": str(tmp_path)}, Mock()) == {
        "test-model": model()
    }
    monkeypatch.setattr(pricing.Path, "home", lambda: tmp_path)
    assert await pricing.load_codex_pricing({}, Mock()) == {"test-model": model()}
    mock_network.assert_not_called()


async def test_custom_url_without_file_does_not_read_default_cache(cache, mock_network):
    log = create_autospec(StructuredLogger, instance=True)
    result = await pricing.load_codex_pricing(
        {"XDG_CACHE_HOME": str(cache.parent.parent), "OPENCODE_MODELS_URL": "https://custom.test"},
        log,
    )
    assert result == {}
    log.warn.assert_called_once_with(
        "codex.pricing.custom_catalog_path_required",
        reason="Set OPENCODE_MODELS_PATH for a custom catalog",
    )
    mock_network.assert_not_called()


@pytest.mark.parametrize("source", [pricing.DEFAULT_MODELS_URL, "https://custom.test"])
async def test_explicit_stale_file_is_authoritative(cache, mock_network, source):
    make_stale(cache)
    assert await pricing.load_codex_pricing(
        {"OPENCODE_MODELS_PATH": str(cache), "OPENCODE_MODELS_URL": source}, Mock()
    ) == {"test-model": model()}
    mock_network.assert_not_called()


@pytest.mark.parametrize("contents", [None, b"bad json", b'{"openai":{"models":[]}}'])
async def test_invalid_explicit_file_never_fetches(cache, mock_network, contents):
    if contents is None:
        cache.unlink()
    else:
        cache.write_bytes(contents)
    assert await pricing.load_codex_pricing({"OPENCODE_MODELS_PATH": str(cache)}, Mock()) == {}
    mock_network.assert_not_called()


@pytest.mark.parametrize("initial", ["stale", "missing", "malformed"])
async def test_refresh_valid_catalog_persists_full_catalog(cache, mock_network, initial):
    if initial == "stale":
        make_stale(cache)
    elif initial == "missing":
        cache.unlink()
    else:
        cache.write_bytes(b"invalid")
    payload = catalog_bytes(4)
    mock_network.side_effect = None
    mock_network.return_value = httpx.Response(200, content=payload)
    assert await pricing.load_codex_pricing(
        {"XDG_CACHE_HOME": str(cache.parent.parent)}, Mock()
    ) == {"test-model": model(input=4)}
    assert cache.read_bytes() == payload
    request = mock_network.call_args.args[0]
    assert request.method == "GET"
    assert str(request.url) == f"{pricing.DEFAULT_MODELS_URL}/api.json"
    assert request.extensions["timeout"]["read"] == pricing.CATALOG_TIMEOUT_SECONDS
    assert list(cache.parent.iterdir()) == [cache]


@pytest.mark.parametrize(
    "failure",
    [
        httpx.ConnectError("offline"),
        httpx.ReadTimeout("timed out"),
        TimeoutError(),
        httpx.Response(503),
        httpx.Response(200, content=b"invalid"),
        httpx.Response(200, json={"openai": {"models": []}}),
        httpx.Response(200, json={"openai": {"models": {"bad": None}}}),
        httpx.Response(200, content=b'{"openai":{"models":{}},"bad":NaN}'),
    ],
)
async def test_failed_refresh_preserves_stale_bytes_and_timestamp(cache, mock_network, failure):
    make_stale(cache)
    before = cache.read_bytes(), cache.stat().st_mtime_ns
    if isinstance(failure, Exception):
        mock_network.side_effect = failure
    else:
        mock_network.side_effect = None
        mock_network.return_value = failure
    log = create_autospec(StructuredLogger, instance=True)
    assert await pricing.load_codex_pricing({"XDG_CACHE_HOME": str(cache.parent.parent)}, log) == {
        "test-model": model()
    }
    assert (cache.read_bytes(), cache.stat().st_mtime_ns) == before
    log.warn.assert_called_once()
    assert log.warn.call_args.args == ("codex.pricing.refresh_failed",)
    assert isinstance(log.warn.call_args.kwargs["exc"], Exception)


async def test_oversized_refresh_preserves_cache(cache, mock_network, monkeypatch):
    make_stale(cache)
    before = cache.read_bytes()
    monkeypatch.setattr(pricing, "MAX_CATALOG_BYTES", len(before))
    mock_network.side_effect = None
    mock_network.return_value = httpx.Response(200, content=before + b" ")
    assert await pricing.load_codex_pricing(
        {"XDG_CACHE_HOME": str(cache.parent.parent)}, Mock()
    ) == {"test-model": model()}
    assert cache.read_bytes() == before


async def test_refresh_has_total_deadline(cache, mock_network, monkeypatch):
    make_stale(cache)
    before = cache.read_bytes()
    monkeypatch.setattr(pricing, "CATALOG_TIMEOUT_SECONDS", 0.01)

    async def delayed_response(request):
        await asyncio.sleep(60)
        return httpx.Response(200, content=catalog_bytes(4))

    mock_network.side_effect = delayed_response
    assert await pricing.load_codex_pricing(
        {"XDG_CACHE_HOME": str(cache.parent.parent)}, Mock()
    ) == {"test-model": model()}
    assert cache.read_bytes() == before


async def test_failed_refresh_without_cache_returns_unknown(cache, mock_network):
    cache.unlink()
    mock_network.side_effect = httpx.ConnectError("offline")
    assert (
        await pricing.load_codex_pricing({"XDG_CACHE_HOME": str(cache.parent.parent)}, Mock()) == {}
    )
    assert not cache.exists()


async def test_http_cancellation_preserves_cache(cache, mock_network):
    make_stale(cache)
    before = cache.read_bytes(), cache.stat().st_mtime_ns
    started = asyncio.Event()

    async def pending_response(request):
        started.set()
        await asyncio.Event().wait()

    mock_network.side_effect = pending_response
    environ = {"XDG_CACHE_HOME": str(cache.parent.parent)}
    log = create_autospec(StructuredLogger, instance=True)
    task = asyncio.create_task(pricing.load_codex_pricing(environ, log))
    try:
        await asyncio.wait_for(started.wait(), timeout=1)
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    assert (cache.read_bytes(), cache.stat().st_mtime_ns) == before
    assert list(cache.parent.iterdir()) == [cache]
    assert environ == {"XDG_CACHE_HOME": str(cache.parent.parent)}
    log.warn.assert_not_called()


async def test_oversized_explicit_cache_is_rejected(cache, monkeypatch, mock_network):
    monkeypatch.setattr(pricing, "MAX_CATALOG_BYTES", cache.stat().st_size - 1)
    assert await pricing.load_codex_pricing({"OPENCODE_MODELS_PATH": str(cache)}, Mock()) == {}
    mock_network.assert_not_called()


async def test_failed_atomic_replace_preserves_cache(cache, mock_network, monkeypatch):
    make_stale(cache)
    before = cache.read_bytes()
    mock_network.side_effect = None
    mock_network.return_value = httpx.Response(200, content=catalog_bytes(4))
    monkeypatch.setattr(pricing.Path, "replace", Mock(side_effect=OSError("read-only")))
    assert await pricing.load_codex_pricing(
        {"XDG_CACHE_HOME": str(cache.parent.parent)}, Mock()
    ) == {"test-model": model(input=4)}
    assert cache.read_bytes() == before
    assert list(cache.parent.iterdir()) == [cache]

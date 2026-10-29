import json
import math
from decimal import Decimal
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from sandbox_runtime.model_prices import (
    MAX_RATE_USD_PER_MILLION_TOKENS,
    ModelPrice,
    ModelPriceCatalog,
    Rates,
    TokenBuckets,
    default_catalog_path,
)

FIXTURE = Path(__file__).parent / "fixtures/reasoning-models.json"
# Legacy over-200k rates must not override the catalog's explicit context tiers.
TIERED = {
    "input": 12,
    "output": 52,
    "cache_read": 1.2,
    "cache_write": 13,
    "context_over_200k": {"input": 24, "output": 78, "cache_read": 2.4, "cache_write": 26},
    "tiers": [
        {
            "input": 25,
            "output": 80,
            "cache_read": 2.5,
            "cache_write": 27,
            "tier": {"type": "context", "size": 272_000},
        }
    ],
}


def only_input(count):
    return TokenBuckets(input=count, output=0, reasoning=0, cache_read=0, cache_write=0)


@pytest.mark.parametrize(
    ("context", "input_rate"),
    [
        (200_000, 12),
        (200_001, 12),
        (230_000, 12),
        (271_999, 12),
        (272_000, 12),
        (272_001, 25),
    ],
)
def test_rate_selection_uses_catalog_context_boundaries(context, input_rate):
    # OpenAI's short-context rates include exactly 272,000 input tokens.
    assert ModelPrice.parse(TIERED).rates_for(context).input == input_rate


def test_largest_exceeded_tier_wins_and_other_tier_types_are_ignored():
    price = ModelPrice.parse(
        {
            "input": 1,
            "output": 1,
            "tiers": [
                {"input": 3, "output": 3, "tier": {"type": "context", "size": 100}},
                {"input": 2, "output": 2, "tier": {"type": "context", "size": 10}},
                {"input": 9, "output": 9, "tier": {"type": "time", "size": 1}},
                {"input": 9, "tier": {"type": "context", "size": 5}},
                "malformed",
            ],
        }
    )
    assert [price.rates_for(n).input for n in (5, 11, 101)] == [1, 2, 3]


def test_cost_prices_every_bucket_with_reasoning_at_the_output_rate():
    price = ModelPrice.parse(TIERED)
    tokens = TokenBuckets(input=1_000, output=100, reasoning=10, cache_read=2_000, cache_write=300)
    # 1000*12 + 100*52 + 10*52 + 2000*1.2 + 300*13 = 24,020 per million.
    assert price.cost(tokens, 3_300) == Decimal("0.02402")


def test_cost_is_exact_decimal_arithmetic():
    price = ModelPrice.parse({"input": 0.1, "output": 0.2})
    tokens = TokenBuckets(input=1, output=1, reasoning=0, cache_read=0, cache_write=0)
    assert price.cost(tokens, 1) == Decimal("0.0000003")


@pytest.mark.parametrize(
    "raw",
    [
        None,
        [],
        {},
        {"input": 1},
        {"input": 1, "output": -1},
        {"input": True, "output": 1},
        {"input": "1", "output": 1},
        {"input": float("inf"), "output": 1},
        {"input": float("nan"), "output": 1},
        {"input": 10**400, "output": 1},
        # Finite, but a cost at this rate can overflow a float.
        {"input": 1e308, "output": 1},
    ],
)
def test_entries_without_a_usable_base_price_are_unpriced(raw):
    assert ModelPrice.parse(raw) is None


def test_missing_or_invalid_cache_rates_are_free():
    price = ModelPrice.parse({"input": 1, "output": 2, "cache_read": -1})
    assert price == ModelPrice(base=Rates(Decimal(1), Decimal(2), Decimal(0), Decimal(0)))
    assert price.rates_for(300_000) == price.base


def test_default_path_follows_opencode_cache_resolution(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    assert default_catalog_path({}) == tmp_path / ".cache/opencode/models.json"
    assert default_catalog_path({"XDG_CACHE_HOME": "/cache"}) == Path("/cache/opencode/models.json")
    assert (
        default_catalog_path({"OPENCODE_MODELS_URL": "https://models.opencode.ai"})
        == tmp_path / ".cache/opencode/models.json"
    )
    assert default_catalog_path({"OPENCODE_MODELS_URL": "https://mirror.example"}) is None
    # An empty source selects the default, as OpenCode's `||` fallback does.
    assert (
        default_catalog_path({"OPENCODE_MODELS_URL": ""})
        == tmp_path / ".cache/opencode/models.json"
    )
    assert default_catalog_path(
        {"OPENCODE_MODELS_URL": "https://mirror.example", "OPENCODE_MODELS_PATH": "/m.json"}
    ) == Path("/m.json")


def test_catalog_reads_openai_prices_from_the_fixture():
    catalog = ModelPriceCatalog(FIXTURE, MagicMock())
    assert catalog.available
    price = catalog.price("gpt-6.1-sol")
    assert price.base == Rates(Decimal(2), Decimal(10), Decimal("0.1"), Decimal("2.5"))
    assert price.rates_for(272_001).input == 4
    assert catalog.price("claude-opus-4-5") is None


@pytest.mark.parametrize(
    ("context", "expected_cost"),
    [(272_000, "0.54275"), (272_001, "1.085304")],
)
def test_published_context_boundary_prices_all_token_buckets(context, expected_cost):
    price = ModelPriceCatalog(FIXTURE, MagicMock()).price("gpt-6.1-sol")
    tokens = TokenBuckets(
        input=context - 1_500, output=20, reasoning=20, cache_read=1_000, cache_write=500
    )
    assert price.cost(tokens, context) == Decimal(expected_cost)


def test_missing_catalog_is_logged_once_and_picked_up_when_it_appears(tmp_path):
    log = MagicMock()
    path = tmp_path / "models.json"
    catalog = ModelPriceCatalog(path, log)
    assert catalog.price("gpt-6-sol") is None
    assert not catalog.available
    assert log.warn.call_count == 1
    path.write_text(json.dumps({"openai": {"models": {"gpt-6-sol": {"cost": TIERED}}}}))
    assert catalog.price("gpt-6-sol").base.input == 12
    log.info.assert_called_once()
    assert log.info.call_args.args == ("model_prices.loaded",)


def test_catalog_recovers_from_read_failure_without_a_file_change(tmp_path, monkeypatch):
    log = MagicMock()
    path = tmp_path / "models.json"
    path.write_bytes(FIXTURE.read_bytes())
    before = path.stat()
    catalog = ModelPriceCatalog(path, log)
    with monkeypatch.context() as blocked:
        blocked.setattr(Path, "read_bytes", MagicMock(side_effect=PermissionError))
        assert catalog.price("gpt-6.1-sol") is None
        assert not catalog.available
    after = path.stat()
    assert (after.st_mtime_ns, after.st_size) == (before.st_mtime_ns, before.st_size)
    assert catalog.price("gpt-6.1-sol").base.input == 2
    assert catalog.available
    log.warn.assert_called_once()
    log.info.assert_called_once()


def test_changed_catalog_is_reloaded_and_unreadable_one_is_unavailable(tmp_path):
    log = MagicMock()
    path = tmp_path / "models.json"
    path.write_text(json.dumps({"openai": {"models": {"gpt-6-sol": {"cost": TIERED}}}}))
    catalog = ModelPriceCatalog(path, log)
    assert catalog.price("gpt-6-sol").base.input == 12
    path.write_text(
        json.dumps({"openai": {"models": {"gpt-6-sol": {"cost": {"input": 3, "output": 4}}}}})
    )
    assert catalog.price("gpt-6-sol").base.input == 3
    path.write_text("{not json")
    assert catalog.price("gpt-6-sol") is None
    assert not catalog.available
    path.write_text(json.dumps({"openai": {"models": []}}))
    assert not catalog.available
    assert log.warn.call_count == 2


def test_uncached_custom_source_is_unavailable():
    catalog = ModelPriceCatalog(None, MagicMock())
    assert catalog.price("gpt-6-sol") is None
    assert not catalog.available


def test_catalog_too_deeply_nested_to_parse_is_unavailable_not_an_error(tmp_path):
    path = tmp_path / "models.json"
    path.write_text("[" * 100_000 + "]" * 100_000)
    catalog = ModelPriceCatalog(path, MagicMock())
    assert catalog.price("gpt-6-sol") is None
    assert not catalog.available


def test_largest_accepted_rate_keeps_the_most_a_turn_can_report_finite():
    rate = float(MAX_RATE_USD_PER_MILLION_TOKENS)
    price = ModelPrice.parse({"input": rate, "output": rate})
    most = 2**53 - 1
    tokens = TokenBuckets(input=most, output=most, reasoning=most, cache_read=0, cache_write=0)
    assert math.isfinite(float(price.cost(tokens, most)))

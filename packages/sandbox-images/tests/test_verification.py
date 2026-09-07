"""Image-contract checks that do not require a running provider sandbox."""

import runpy
from pathlib import Path
from unittest.mock import Mock

import pytest

verification = runpy.run_path(str(Path(__file__).parents[1] / "verify/image.py"))


@pytest.mark.parametrize("os_family", ["debian", "amazon-linux"])
def test_package_inventory_is_independent_of_query_order(os_family):
    probe = Mock()
    probe.run.side_effect = ["zlib=1\nalpha=2", "alpha=2\nzlib=1"]
    collect = verification["installed_os_packages"]
    assert collect(probe, os_family) == collect(probe, os_family) == ["alpha=2", "zlib=1"]

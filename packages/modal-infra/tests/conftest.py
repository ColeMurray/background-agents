"""Register test functions with an inert image reference, without provider access."""

import importlib
import os
from unittest.mock import patch

# Production imports require a verified image. Tests mock all native operations;
# keep their declaration-only reference out of the environment used by tests.
with (
    patch("modal.is_local", return_value=False),
    patch.dict(os.environ, {"OPENINSPECT_MODAL_BASE_IMAGE_ID": "im-test-functions"}),
):
    importlib.import_module("src")

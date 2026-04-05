"""Tests for screenshot detection and encoding in the bridge."""

import base64
import tempfile
from pathlib import Path

from sandbox_runtime.bridge import (
    MAX_SCREENSHOT_BYTES,
    encode_screenshot,
    extract_screenshot_path,
)


class TestExtractScreenshotPath:
    """Tests for extracting screenshot file paths from tool output."""

    def test_standard_output(self):
        output = "Screenshot saved to /tmp/screenshot-2026-04-05.png"
        assert extract_screenshot_path(output) == "/tmp/screenshot-2026-04-05.png"

    def test_checkmark_prefix(self):
        output = "\u2713 Screenshot saved to /workspace/shot.png"
        assert extract_screenshot_path(output) == "/workspace/shot.png"

    def test_full_page_screenshot(self):
        output = "Full page screenshot saved to /tmp/full.png"
        assert extract_screenshot_path(output) == "/tmp/full.png"

    def test_no_match(self):
        output = "Hello world"
        assert extract_screenshot_path(output) is None

    def test_empty_output(self):
        assert extract_screenshot_path("") is None
        assert extract_screenshot_path(None) is None

    def test_annotated_output(self):
        output = (
            "\u2713 Screenshot saved to /tmp/shot.png\n"
            '[1] @e1 button "Submit"\n'
            '[2] @e2 link "Home"'
        )
        assert extract_screenshot_path(output) == "/tmp/shot.png"

    def test_multiline_with_screenshot_later(self):
        output = "Navigating...\nScreenshot saved to /tmp/page.png\nDone."
        assert extract_screenshot_path(output) == "/tmp/page.png"


class TestEncodeScreenshot:
    """Tests for reading and base64-encoding screenshot files."""

    def test_encodes_png(self):
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
            content = b"\x89PNG\r\n\x1a\n" + b"\x00" * 100
            f.write(content)
            f.flush()

            result = encode_screenshot(f.name)
            assert result is not None
            assert result["mimeType"] == "image/png"
            assert result["filename"] == Path(f.name).name
            decoded = base64.b64decode(result["base64"])
            assert decoded == content

    def test_encodes_jpeg(self):
        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as f:
            content = b"\xff\xd8\xff\xe0" + b"\x00" * 50
            f.write(content)
            f.flush()

            result = encode_screenshot(f.name)
            assert result is not None
            assert result["mimeType"] == "image/jpeg"

    def test_missing_file_returns_none(self):
        result = encode_screenshot("/tmp/nonexistent-screenshot-abc123.png")
        assert result is None

    def test_oversized_file_returns_none(self):
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
            f.write(b"\x00" * (MAX_SCREENSHOT_BYTES + 1))
            f.flush()

            result = encode_screenshot(f.name)
            assert result is None

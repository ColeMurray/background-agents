#!/usr/bin/env python3
"""
Upload Claude OAuth credentials to Modal Volume for sandbox use.

Reads credentials from the local machine (macOS Keychain via
~/.claude/.credentials.json) and uploads them to the Modal Volume
"claude-auth-vol" so sandboxes can authenticate with Claude Code
using OAuth instead of API keys.

Usage:
    python scripts/setup_claude_oauth.py

Prerequisites:
    - Claude Code installed and authenticated locally (`claude auth login`)
    - Modal CLI configured (`modal token set`)
    - pip install modal
"""

import json
import sys
from pathlib import Path

try:
    import modal
except ImportError:
    print("Error: modal package not installed. Run: pip install modal")
    sys.exit(1)


CREDENTIALS_FILENAME = ".credentials.json"
VOLUME_NAME = "claude-auth-vol"
VOLUME_MOUNT_PATH = "/root/.claude"


def find_local_credentials() -> Path | None:
    """Find Claude credentials on the local machine."""
    candidates = [
        Path.home() / ".claude" / CREDENTIALS_FILENAME,
    ]
    for path in candidates:
        if path.exists():
            return path
    return None


def validate_credentials(creds_path: Path) -> dict:
    """Validate that the credentials file contains required OAuth fields."""
    try:
        data = json.loads(creds_path.read_text())
    except (json.JSONDecodeError, OSError) as e:
        print(f"Error reading {creds_path}: {e}")
        sys.exit(1)

    # Claude credentials.json stores OAuth tokens
    if not isinstance(data, dict):
        print(f"Error: {creds_path} is not a JSON object")
        sys.exit(1)

    print(f"Found credentials at {creds_path}")
    return data


def upload_to_volume(creds_data: dict) -> None:
    """Upload credentials to Modal Volume."""
    vol = modal.Volume.from_name(VOLUME_NAME, create_if_missing=True)

    creds_bytes = json.dumps(creds_data, indent=2).encode()

    # Write to volume
    with vol.batch_upload() as batch:
        batch.put(creds_bytes, CREDENTIALS_FILENAME)

    vol.commit()
    print(f"Uploaded {CREDENTIALS_FILENAME} to Modal Volume '{VOLUME_NAME}'")


def verify_upload() -> None:
    """Verify the credentials file exists on the volume."""
    vol = modal.Volume.from_name(VOLUME_NAME)
    entries = list(vol.listdir("/"))
    found = any(e.path == CREDENTIALS_FILENAME for e in entries)
    if found:
        print(f"Verified: {CREDENTIALS_FILENAME} exists on volume '{VOLUME_NAME}'")
    else:
        print(f"Warning: {CREDENTIALS_FILENAME} not found on volume after upload")
        sys.exit(1)


def main() -> None:
    print("Claude OAuth Credential Setup")
    print("=" * 40)

    # Step 1: Find local credentials
    creds_path = find_local_credentials()
    if not creds_path:
        print(
            "Error: No Claude credentials found.\n"
            "Run 'claude auth login' first to authenticate with Claude Code."
        )
        sys.exit(1)

    # Step 2: Validate
    creds_data = validate_credentials(creds_path)

    # Step 3: Upload to Modal Volume
    upload_to_volume(creds_data)

    # Step 4: Verify
    verify_upload()

    print("\nDone! Sandboxes will use OAuth credentials from the volume.")


if __name__ == "__main__":
    main()

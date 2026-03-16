"""
Configuration from environment variables for Open-Inspect Daytona infrastructure.

All configuration is read from environment variables at startup.
"""

import os
from dataclasses import dataclass, field


@dataclass
class Config:
    """Application configuration from environment variables."""

    # Daytona SDK
    daytona_api_url: str = ""
    daytona_api_key: str = ""

    # Authentication
    daytona_api_secret: str = ""  # Shared HMAC secret (same role as MODAL_API_SECRET)
    internal_callback_secret: str = ""  # For outbound callbacks to control plane

    # LLM
    anthropic_api_key: str = ""

    # GitHub App
    github_app_id: str = ""
    github_app_private_key: str = ""
    github_app_installation_id: str = ""
    github_hostname: str = "github.com"  # For GHES support

    # Control plane
    control_plane_url: str = ""
    allowed_control_plane_hosts: set[str] = field(default_factory=set)

    # Sandbox
    sandbox_base_image: str = ""  # Docker image for sandboxes

    # S3/MinIO for snapshots
    s3_endpoint: str = ""
    s3_access_key: str = ""
    s3_secret_key: str = ""
    s3_bucket: str = "open-inspect-data"

    @classmethod
    def _read_private_key(cls) -> str:
        """Read GitHub App private key from env var or file."""
        key = os.environ.get("GITHUB_APP_PRIVATE_KEY", "")
        if key:
            return key
        key_file = os.environ.get("GITHUB_APP_PRIVATE_KEY_FILE", "")
        if key_file and os.path.isfile(key_file):
            with open(key_file) as f:
                return f.read().strip()
        return ""

    @classmethod
    def from_env(cls) -> "Config":
        """Load configuration from environment variables."""
        hosts_str = os.environ.get("ALLOWED_CONTROL_PLANE_HOSTS", "")
        allowed_hosts = {h.strip().lower() for h in hosts_str.split(",") if h.strip()} if hosts_str else set()

        return cls(
            daytona_api_url=os.environ.get("DAYTONA_API_URL", ""),
            daytona_api_key=os.environ.get("DAYTONA_API_KEY", ""),
            daytona_api_secret=os.environ.get("DAYTONA_API_SECRET", ""),
            internal_callback_secret=os.environ.get("INTERNAL_CALLBACK_SECRET", ""),
            anthropic_api_key=os.environ.get("ANTHROPIC_API_KEY", ""),
            github_app_id=os.environ.get("GITHUB_APP_ID", ""),
            github_app_private_key=cls._read_private_key(),
            github_app_installation_id=os.environ.get("GITHUB_APP_INSTALLATION_ID", ""),
            github_hostname=os.environ.get("GITHUB_HOSTNAME", "github.com"),
            control_plane_url=os.environ.get("CONTROL_PLANE_URL", ""),
            allowed_control_plane_hosts=allowed_hosts,
            sandbox_base_image=os.environ.get("SANDBOX_BASE_IMAGE", ""),
            s3_endpoint=os.environ.get("S3_ENDPOINT", ""),
            s3_access_key=os.environ.get("S3_ACCESS_KEY", ""),
            s3_secret_key=os.environ.get("S3_SECRET_KEY", ""),
            s3_bucket=os.environ.get("S3_BUCKET", "open-inspect-data"),
        )

"""
Main FastAPI application for Open-Inspect Daytona infrastructure.

This module defines the FastAPI app, lifespan (startup/shutdown),
and shared resources (Daytona client, S3 client, config).
"""

from contextlib import asynccontextmanager
from urllib.parse import urlparse

import boto3
from daytona_sdk import Daytona, DaytonaConfig
from fastapi import FastAPI

from .config import Config
from .log_config import configure_logging, get_logger

configure_logging()
log = get_logger("app")


def _create_daytona_client(config: Config) -> Daytona:
    """Create a Daytona SDK client from configuration."""
    daytona_config = DaytonaConfig(
        api_url=config.daytona_api_url,
        api_key=config.daytona_api_key,
    )
    return Daytona(daytona_config)


def _create_s3_client(config: Config):
    """Create a boto3 S3 client for MinIO/S3 snapshot storage."""
    kwargs = {
        "service_name": "s3",
        "aws_access_key_id": config.s3_access_key,
        "aws_secret_access_key": config.s3_secret_key,
    }
    if config.s3_endpoint:
        kwargs["endpoint_url"] = config.s3_endpoint
    return boto3.client(**kwargs)


def validate_control_plane_url(url: str | None) -> bool:
    """
    Validate that a control_plane_url is allowed.

    Validation rules:
    1. Empty/None URLs are allowed (optional field)
    2. URL's host (including port) must be in ALLOWED_CONTROL_PLANE_HOSTS

    Args:
        url: The control plane URL to validate

    Returns:
        True if the URL is allowed, False otherwise
    """
    if not url:
        return True  # Empty URL is allowed (optional field)

    config = app.state.config
    allowed_hosts = config.allowed_control_plane_hosts

    if not allowed_hosts:
        # Fail closed: if no allowed hosts configured, reject all URLs
        log.warn("security.hosts_not_configured")
        return False

    try:
        parsed = urlparse(url)
        host = parsed.netloc.lower()
        return host in allowed_hosts
    except Exception as e:
        log.warn("security.url_parse_error", exc=e)
        return False


@asynccontextmanager
async def lifespan(application: FastAPI):
    """Application lifespan: create shared clients on startup, clean up on shutdown."""
    config = Config.from_env()
    application.state.config = config

    # Create Daytona client
    application.state.daytona = _create_daytona_client(config)
    log.info("app.daytona_client_ready", api_url=config.daytona_api_url)

    # Create S3 client
    application.state.s3 = _create_s3_client(config)
    log.info("app.s3_client_ready", endpoint=config.s3_endpoint, bucket=config.s3_bucket)

    # Ensure S3 bucket exists
    try:
        application.state.s3.head_bucket(Bucket=config.s3_bucket)
    except Exception:
        try:
            application.state.s3.create_bucket(Bucket=config.s3_bucket)
            log.info("app.s3_bucket_created", bucket=config.s3_bucket)
        except Exception as e:
            log.warn("app.s3_bucket_error", exc=e, bucket=config.s3_bucket)

    log.info("app.startup_complete")
    yield
    log.info("app.shutdown")


# Create the FastAPI application
app = FastAPI(
    title="Open-Inspect Daytona Infrastructure",
    lifespan=lifespan,
)

# Import and include routes after app is created to avoid circular imports
from .web_api import router  # noqa: E402

app.include_router(router)

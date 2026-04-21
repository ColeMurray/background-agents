"""CLI utilities for Open-Inspect Modal functions."""

from .app import app


@app.local_entrypoint()
def check_health():
    """Check service health."""
    from .functions import health_check

    result = health_check.remote()
    print(f"Health: {result}")

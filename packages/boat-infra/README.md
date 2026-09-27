# Boat Infrastructure

Builds the verified Boat named snapshot used by Open-Inspect session sandboxes.

```bash
BOAT_BUILD_API_KEY=... \
BOAT_TEMPLATE_PREFIX=openinspect-production \
uv run --frozen python build_template.py
```

The builder creates only finite-TTL, no-env temporary sandboxes. It installs the shared image
bundle, saves an immutable hash-qualified named snapshot, boots a fresh verifier, runs the full
image smoke suite plus a private hosted-WebSocket probe, and deletes temporary sandboxes. It never
deletes snapshots outside `BOAT_TEMPLATE_PREFIX`.

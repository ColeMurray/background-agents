"""Retryable terminal VM capture, keyed by the generation's stable source reference.

Modal Dict receipts survive function restarts and are retained for seven days
without access. A captured image is recorded before source retirement. An
unfinished capture intent is deliberately not retried: its outcome is unknown.
"""

import modal

from ..app_config import APP_NAME
from .manager import SandboxManager

_receipts = modal.Dict.from_name(f"{APP_NAME}-vm-terminal-snapshots", create_if_missing=True)


async def recover_vm_snapshot(reference: str) -> str | None:
    """Read an existing capture receipt; never capture or retire any source."""
    receipt = await _receipts.get.aio(reference)
    return receipt.get("image_id") if receipt else None


async def recorded_vm_source(reference: str) -> str | None:
    """Resolve a launch reference after capture, even when its named source is gone."""
    receipt = await _receipts.get.aio(reference)
    return receipt["source_id"] if receipt else None


async def snapshot_vm(manager: SandboxManager, reference: str, timeout_seconds: float) -> str:
    """Recover a prior receipt or capture once, then confirm source retirement."""
    receipt = await _receipts.get.aio(reference)
    if receipt is None:
        handle = await manager.get_sandbox_by_id(reference)
        if handle is None or handle.sandbox_backend != "modal-vm":
            raise RuntimeError("Terminal capture requires a confirmed VM source")
        intent = {"source_id": handle.modal_object_id, "image_id": None}
        if await _receipts.put.aio(reference, intent, skip_if_exists=True):
            image_id = await manager.take_snapshot(handle, timeout_seconds=timeout_seconds)
            receipt = {**intent, "image_id": image_id}
            # Never retire if this write fails or its outcome is unknown.
            await _receipts.put.aio(reference, receipt)
        else:
            receipt = await _receipts.get.aio(reference)
    recorded_image_id = receipt.get("image_id") if receipt else None
    if not isinstance(recorded_image_id, str) or not recorded_image_id:
        raise RuntimeError("Terminal capture is in progress or its result is unconfirmed")
    await manager.stop_sandbox(receipt["source_id"])
    return recorded_image_id

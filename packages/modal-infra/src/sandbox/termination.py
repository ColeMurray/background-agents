"""Wait for Modal sandbox retirement, including already-timed-out sandboxes."""

import modal


async def terminate_and_wait(sandbox: modal.Sandbox) -> int | None:
    try:
        return await sandbox.terminate.aio(wait=True)
    except modal.exception.SandboxTimeoutError:
        # Modal sets returncode before raising when the sandbox ended by timeout.
        return sandbox.returncode

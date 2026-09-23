"""Best-effort Linux resource counters for diagnosing an unresponsive sandbox."""

from contextlib import suppress
from pathlib import Path

_MEMINFO = Path("/proc/meminfo")
_MEMORY_PRESSURE = Path("/proc/pressure/memory")
_CGROUP_MEMORY_CURRENT = Path("/sys/fs/cgroup/memory.current")
_CGROUP_MEMORY_MAX = Path("/sys/fs/cgroup/memory.max")
_CGROUP_MEMORY_EVENTS = Path("/sys/fs/cgroup/memory.events")


def _read(path: Path) -> str | None:
    try:
        return path.read_text()
    except OSError:
        return None


def _mib(value: str) -> int | None:
    try:
        return int(value) // (1024 * 1024)
    except ValueError:
        return None


def read_health_snapshot() -> dict[str, int | float]:
    """Return only available numeric counters; never block heartbeat on missing proc files."""
    result: dict[str, int | float] = {}

    meminfo = _read(_MEMINFO)
    if meminfo is not None:
        for line in meminfo.splitlines():
            if line.startswith("MemAvailable:"):
                with suppress(IndexError, ValueError):
                    result["memory_available_mib"] = int(line.split()[1]) // 1024
                break

    for path, field in (
        (_CGROUP_MEMORY_CURRENT, "cgroup_memory_current_mib"),
        (_CGROUP_MEMORY_MAX, "cgroup_memory_max_mib"),
    ):
        value = _read(path)
        if value is not None and (parsed := _mib(value.strip())) is not None:
            result[field] = parsed

    events = _read(_CGROUP_MEMORY_EVENTS)
    if events is not None:
        for line in events.splitlines():
            key, _, value = line.partition(" ")
            if key in {"oom", "oom_kill"}:
                with suppress(ValueError):
                    result[f"cgroup_{key}_count"] = int(value)

    pressure = _read(_MEMORY_PRESSURE)
    if pressure is not None:
        for line in pressure.splitlines():
            if line.startswith("some "):
                for field in line.split()[1:]:
                    if field.startswith("avg10="):
                        with suppress(ValueError):
                            result["memory_psi_some_avg10"] = float(field.removeprefix("avg10="))
                break

    return result

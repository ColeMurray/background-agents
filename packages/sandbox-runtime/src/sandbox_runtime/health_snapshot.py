"""Best-effort Linux resource counters for diagnosing an unresponsive sandbox."""

from contextlib import suppress
from pathlib import Path

_MEMINFO = Path("/proc/meminfo")
_LOADAVG = Path("/proc/loadavg")
_VMSTAT = Path("/proc/vmstat")
_PRESSURE_FILES = {
    "cpu": Path("/proc/pressure/cpu"),
    "memory": Path("/proc/pressure/memory"),
    "io": Path("/proc/pressure/io"),
}
_SELF_STATUS = Path("/proc/self/status")
_CGROUP_MEMORY_CURRENT = Path("/sys/fs/cgroup/memory.current")
_CGROUP_MEMORY_MAX = Path("/sys/fs/cgroup/memory.max")
_CGROUP_MEMORY_EVENTS = Path("/sys/fs/cgroup/memory.events")
_MEMINFO_FIELDS = {
    "MemAvailable": "memory_available_mib",
    "SwapTotal": "swap_total_mib",
    "SwapFree": "swap_free_mib",
}
_VMSTAT_COUNTERS = {
    "oom_kill",
    "pswpout",
    "pgmajfault",
    "pgscan_direct",
    "pgscan_kswapd",
    "allocstall_normal",
}


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
            name, _, value = line.partition(":")
            field = _MEMINFO_FIELDS.get(name)
            if field is not None:
                with suppress(IndexError, ValueError):
                    result[field] = int(value.split()[0]) // 1024

    loadavg = _read(_LOADAVG)
    if loadavg is not None:
        with suppress(IndexError, ValueError):
            fields = loadavg.split()
            result["load_avg_1m"] = float(fields[0])
            result["runnable_processes"] = int(fields[3].split("/")[0])

    vmstat = _read(_VMSTAT)
    if vmstat is not None:
        for line in vmstat.splitlines():
            name, _, value = line.partition(" ")
            if name in _VMSTAT_COUNTERS:
                with suppress(ValueError):
                    result[f"vmstat_{name}"] = int(value)

    for path, field in (
        (_CGROUP_MEMORY_CURRENT, "cgroup_memory_current_mib"),
        (_CGROUP_MEMORY_MAX, "cgroup_memory_max_mib"),
    ):
        raw_value = _read(path)
        if raw_value is not None and (parsed := _mib(raw_value.strip())) is not None:
            result[field] = parsed

    events = _read(_CGROUP_MEMORY_EVENTS)
    if events is not None:
        for line in events.splitlines():
            key, _, value = line.partition(" ")
            if key in {"oom", "oom_kill"}:
                with suppress(ValueError):
                    result[f"cgroup_{key}_count"] = int(value)

    for resource, path in _PRESSURE_FILES.items():
        pressure = _read(path)
        if pressure is not None:
            for line in pressure.splitlines():
                if line.startswith("some "):
                    for field in line.split()[1:]:
                        if field.startswith("avg10="):
                            with suppress(ValueError):
                                result[f"{resource}_psi_some_avg10"] = float(
                                    field.removeprefix("avg10=")
                                )
                    break

    status = _read(_SELF_STATUS)
    if status is not None:
        for line in status.splitlines():
            if line.startswith("VmRSS:"):
                with suppress(IndexError, ValueError):
                    result["process_rss_mib"] = int(line.split()[1]) // 1024
            elif line.startswith("Threads:"):
                with suppress(IndexError, ValueError):
                    result["process_threads"] = int(line.split()[1])

    return result

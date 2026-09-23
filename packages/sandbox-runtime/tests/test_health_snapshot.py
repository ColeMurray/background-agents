from sandbox_runtime import health_snapshot


def test_reads_available_linux_resource_counters(tmp_path, monkeypatch):
    files = {
        "_MEMINFO": "MemTotal: 4096000 kB\nMemAvailable: 1536000 kB\n",
        "_SELF_STATUS": "Name:\tpython\nVmRSS:\t102400 kB\nThreads:\t8\n",
        "_CGROUP_MEMORY_CURRENT": "2147483648\n",
        "_CGROUP_MEMORY_MAX": "4294967296\n",
        "_CGROUP_MEMORY_EVENTS": "low 0\noom 3\noom_kill 1\n",
    }
    for name, content in files.items():
        path = tmp_path / name
        path.write_text(content)
        monkeypatch.setattr(health_snapshot, name, path)
    pressure = {}
    for resource, value in (("cpu", "0.25"), ("memory", "12.50"), ("io", "1.75")):
        path = tmp_path / f"{resource}.pressure"
        path.write_text(f"some avg10={value} avg60=2.00 total=1\n")
        pressure[resource] = path
    monkeypatch.setattr(health_snapshot, "_PRESSURE_FILES", pressure)

    assert health_snapshot.read_health_snapshot() == {
        "memory_available_mib": 1500,
        "memory_psi_some_avg10": 12.5,
        "cpu_psi_some_avg10": 0.25,
        "io_psi_some_avg10": 1.75,
        "process_rss_mib": 100,
        "process_threads": 8,
        "cgroup_memory_current_mib": 2048,
        "cgroup_memory_max_mib": 4096,
        "cgroup_oom_count": 3,
        "cgroup_oom_kill_count": 1,
    }


def test_missing_or_unlimited_counters_are_omitted(tmp_path, monkeypatch):
    for name in (
        "_MEMINFO",
        "_SELF_STATUS",
        "_CGROUP_MEMORY_CURRENT",
        "_CGROUP_MEMORY_EVENTS",
    ):
        monkeypatch.setattr(health_snapshot, name, tmp_path / name)
    monkeypatch.setattr(
        health_snapshot,
        "_PRESSURE_FILES",
        {resource: tmp_path / resource for resource in ("cpu", "memory", "io")},
    )
    maximum = tmp_path / "memory.max"
    maximum.write_text("max\n")
    monkeypatch.setattr(health_snapshot, "_CGROUP_MEMORY_MAX", maximum)

    assert health_snapshot.read_health_snapshot() == {}

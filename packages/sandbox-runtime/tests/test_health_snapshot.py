from sandbox_runtime import health_snapshot


def test_reads_available_linux_resource_counters(tmp_path, monkeypatch):
    files = {
        "_MEMINFO": "MemTotal: 4096000 kB\nMemAvailable: 1536000 kB\n",
        "_MEMORY_PRESSURE": "some avg10=12.50 avg60=2.00 total=1\nfull avg10=0.00\n",
        "_CGROUP_MEMORY_CURRENT": "2147483648\n",
        "_CGROUP_MEMORY_MAX": "4294967296\n",
        "_CGROUP_MEMORY_EVENTS": "low 0\noom 3\noom_kill 1\n",
    }
    for name, content in files.items():
        path = tmp_path / name
        path.write_text(content)
        monkeypatch.setattr(health_snapshot, name, path)

    assert health_snapshot.read_health_snapshot() == {
        "memory_available_mib": 1500,
        "memory_psi_some_avg10": 12.5,
        "cgroup_memory_current_mib": 2048,
        "cgroup_memory_max_mib": 4096,
        "cgroup_oom_count": 3,
        "cgroup_oom_kill_count": 1,
    }


def test_missing_or_unlimited_counters_are_omitted(tmp_path, monkeypatch):
    for name in (
        "_MEMINFO",
        "_MEMORY_PRESSURE",
        "_CGROUP_MEMORY_CURRENT",
        "_CGROUP_MEMORY_EVENTS",
    ):
        monkeypatch.setattr(health_snapshot, name, tmp_path / name)
    maximum = tmp_path / "memory.max"
    maximum.write_text("max\n")
    monkeypatch.setattr(health_snapshot, "_CGROUP_MEMORY_MAX", maximum)

    assert health_snapshot.read_health_snapshot() == {}

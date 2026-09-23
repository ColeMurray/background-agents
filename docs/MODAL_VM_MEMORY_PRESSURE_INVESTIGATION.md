# Modal VM memory-pressure investigation

_Investigation recap · September 23, 2026 · Publication draft_

## The short version

Several coding sessions on Modal VMs, including 4 GiB machines, failed with `heartbeat_timeout`,
even though the agent was still working. The failure was not a fixed ten-minute sandbox deadline,
and the logs did not show an OOM kill. The strongest explanation is a workload-induced
resource-feedback loop: concurrent, uncapped Vitest suites spawned many Node workers; VM memory
approached exhaustion; Linux spent substantial time in direct memory reclaim; and the Python bridge
and supervisor stopped getting timely execution. The control plane's 90-second heartbeat threshold
then marked the sandbox stale. Subsequent WebSocket reconnects, OpenCode requests, and diff reports
failed because the session had already been stopped.

The key configuration surprise was that requesting two Modal CPU cores did **not** cap the VM at two
cores. Modal VM memory is fixed at the requested size, while CPU can burst above its request. In a
probe with `cpu=2`, Node reported `os.availableParallelism() === 18`; with `cpu=(2, 2)`, it reported
`2`. Vitest uses available parallelism to select its default worker count. This let a CPU-hungry
test workload scale into a fixed-memory guest.
[Modal VM resource model](https://modal.com/docs/guide/vm-sandboxes#resource-model) ·
[Modal sandbox resource limits](https://modal.com/docs/guide/sandbox-resources#resource-limits) ·
[Vitest worker configuration](https://vitest.dev/config/maxworkers)

## What happened

The first useful trace came from a failing production session. At 18:55 UTC the agent started six
checks together, including two typechecks, a web test suite, two lints, and Prettier. The bridge's
healthy heartbeat tick delay of single-digit milliseconds later rose to **57,867 ms**, then **72,908
ms**. Reported available memory fell from about **2,010 MiB** to **71–72 MiB**. The WebSocket
closed, reconnect handshakes and local OpenCode HTTP calls timed out, and the 300-second SSE
inactivity guard eventually fired after 693 seconds of elapsed wall time. Those timeouts were
downstream symptoms of a runtime that was barely making progress.

We increased the VM to 4 GiB, but another session failed during concurrent web and control-plane
test runs. Available memory dropped from **2,923 MiB** to **1,612 MiB**, then to **567 MiB**; the
next bridge health record was **223,394 ms late**. The control plane had already logged
`sandbox.heartbeat_stale` at **90,372 ms** since the previous heartbeat, just over its 90-second
threshold. The Modal dashboard showed CPU use far above the requested baseline while memory use
climbed toward the VM's 4 GiB allocation. Its CPU-pressure graph showed only a short **1.6%** stall
sample, so the dashboard alone did not establish sustained CPU scheduler starvation.

We added an independent supervisor observer and guest `/proc` diagnostics, then ran controlled
reproductions:

| Run                      | Workload and observation                                                                                                                                                                                                                                                         | Outcome                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Uncapped reproduction A  | Two concurrent, uncapped Vitest suites on a 4 GiB VM. `MemAvailable` reached about **238 MiB**; guest `pgscan_direct` rose from **147 million** to **602 million**; system load exceeded **50**. Both independent observers recorded roughly **99 seconds** of scheduling delay. | Heartbeat expired and the control plane stopped the session. |
| Uncapped reproduction B  | Another uncapped run recorded roughly **290 million** direct-reclaim scans and **75 seconds** of observer delay.                                                                                                                                                                 | Reproduced the pressure pattern.                             |
| Worker-capped comparison | Same two suites concurrently, each invoked with `--maxWorkers=2`. Both suites passed. Heartbeat lag stayed at **0–2 ms** and direct-reclaim scans totaled only **333**.                                                                                                          | No heartbeat failure.                                        |

`pgscan_direct` is a Linux guest counter for pages scanned while a task is trying to reclaim memory
directly. It is cumulative, not a count of bytes or an exact measure of stall duration. The large
increase, low available RAM, many Node workers, and delayed independent observers together support
memory-reclaim pressure as the immediate mechanism. The guest's OOM-kill counter remained **zero**
in these runs; an OOM kill is not required for a VM to become unresponsive.

## Why a heartbeat failure looked like a network failure

The bridge's heartbeat and its WebSocket to the control plane need the Python process to run
promptly. When the guest was under heavy reclaim, even the independent supervisor observer was late.
The control plane correctly interpreted the missing heartbeat as an unresponsive sandbox and moved
it to stale/stopped state. After that transition, sandbox-token verification and diff reporting
returned `401`, and reconnect attempts were rejected. Those authorization errors were consequences
of the stale transition, not evidence that auth broke first. Likewise, the SSE inactivity error was
a later guardrail, not the initiating event.

## Mitigation and validation

We made two complementary changes in
[public PR #2016](https://github.com/ColeMurray/background-agents/pull/2016):

1. Modal VM launches now use `cpu=(cpuCores, cpuCores)`, applying a hard upper limit rather than a
   request that can burst. The VM default remains two physical cores and 4 GiB of memory. The gVisor
   offering is unchanged.
2. The web and control-plane Vitest configs each set `maxWorkers: 2`, so an agent running either
   suite does not rely on the VM's reported host parallelism.
   [Vitest describes worker parallelism here](https://vitest.dev/guide/parallelism).

In a fresh production canary, Node reported available parallelism of **2**. Concurrent, unflagged
web and control-plane test commands both passed (1,883 and 5,140 tests). Observed bridge heartbeat
lag stayed at **0–7 ms**, available memory remained above **2 GiB**, and direct reclaim and OOM-kill
counters stayed at zero during the run. The first agent tool invocation hit its separate 120-second
tool timeout; retrying with a longer tool timeout completed the suites. That tool timeout was not
another sandbox heartbeat failure.

## Confidence and limits

This is a **strong workload-level diagnosis**, not proof of a Modal host defect or a single
offending allocation. We directly observed guest memory pressure, runaway worker concurrency,
delayed independent processes, and a successful bounded-concurrency comparison. We did not prove
which process allocation first crossed the threshold, obtain a kernel trace of the blocked tasks, or
establish a provider-side scheduling problem. The CPU cap and test-worker cap resolved the
reproduced workload; they do not guarantee that every arbitrary agent command will stay within 4
GiB.

The broader lesson is that a CPU _request_ and a memory _allocation_ are not symmetric controls. For
agent-driven workloads, explicitly cap CPU burst and application-level fan-out, then monitor guest
reclaim and heartbeat scheduling delay—not just OOM events or the dashboard's memory-used line.
Modal's documentation specifically recommends upper resource limits for agent-controlled sandboxes.
[Modal sandbox resource limits](https://modal.com/docs/guide/sandbox-resources#resource-limits)

_The production session identifiers are withheld; the measurements above come from session,
control-plane, and Modal VM guest logs collected during this investigation._

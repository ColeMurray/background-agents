Feature: Durable authorized Pi sandbox execution
  Background:
    Given a Pi session whose immutable sandbox-execution capability is enabled
    And SessionDO remains the authority for actors, approvals, commands, and timeline projection

  Scenario: Real providers remain unavailable without generation 78 proof
    Given sandbox execution mode is enabled
    When capability discovery evaluates any real provider
    Then sandbox execution is unavailable with a canary-blocked reason
    And no run, build, or test tool is installed

  Scenario: One authorized command is admitted exactly once
    When Pi invokes run_shell, run_build, or run_tests for a durable task and call
    Then SessionDO records one immutable fingerprint, original actor, approval revision, credential profile, and egress profile
    And replay of the same tool call returns the same command
    And different input for that command identifier is rejected

  Scenario: Dispatch recovers before process start
    Given a command was dispatched but its acceptance or start was not observed
    When the send fails or the execution bridge reconnects
    Then SessionDO retries the same command identifier within a bounded attempt count
    And the bridge starts at most one process for that identifier

  Scenario: Running output is bounded and pageable
    Given an accepted command is running
    When the bridge emits ordered stdout or stderr
    Then SessionDO persists at most 256 KiB for the command and 1 MiB for its operation
    And authorized collaborators can page status and output through the session BFF
    And Pi receives at most 64 KiB of model-visible result text

  Scenario: Cancellation escalates when execution cannot stop
    Given cancellation was requested for a dispatched or running command
    When cancellation delivery fails or its grace deadline expires
    Then SessionDO retries cancellation before the deadline
    And an uninterruptible command fences and replaces its provider generation
    And its result becomes indeterminate and is never automatically retried

  Scenario: Operation completion cancels remaining commands
    Given a Pi operation has queued, dispatched, or running commands
    When the Pi operation ends or its exact tool abort signal fires
    Then SessionDO durably requests cancellation for the operation or exact command
    And later completion is acknowledged idempotently without changing a conflicting terminal result

  Scenario: Replay gaps and bridge replacement are explicit
    Given SessionDO requests output replay after reconnect
    When the bridge reports an output gap or a different generation becomes authoritative
    Then SessionDO records an explicit indeterminate result
    And late completion remains acknowledged and does not trigger another command execution

  Scenario: Quotas and retention remain bounded
    Then at most one command runs per session
    And at most four commands wait per session and eight commands exist per operation
    And the default command timeout is 15 minutes without exceeding provider lifetime
    And completion errors and retained metadata are bounded and pruned

  Scenario: Preservation blocks new execution without stranding cancellation
    Given SessionDO begins preservation
    Then new commands are denied
    And admitted running commands are stopped or marked indeterminate before generation replacement

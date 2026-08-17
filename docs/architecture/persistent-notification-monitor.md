# Persistent desktop notification monitor

## Status

Investigation and implementation plan only. No monitor implementation exists yet.

## Problem

Fleet's macOS/Linux desktop notifications are emitted by the interactive TUI. The same TUI intentionally exits after several normal dashboard actions. When it is the only process in a dedicated tmux session, exiting also removes that session and silently stops desktop notification monitoring.

The tmux status line can continue showing attention because `fleet status --statusline` reads current hook state independently. This creates the observed split:

- status-line `DONE` chip appears;
- no desktop notification appears;
- no `FleetNotifier` delivery process or macOS notification request exists.

One Fleet process is sufficient for every session/window on a single tmux server because Fleet scans all panes. A separate monitor is needed for each independent tmux socket, not for each tmux session.

## Verified exit paths

The interactive TUI calls `finish()` and exits on:

- `q`;
- `Esc` from the main dashboard;
- `Ctrl-C`;
- Enter on a selected agent, including Enter while filtering;
- double-clicking an agent;
- `n` when used as “next waiting agent” (except the preview permission-denial case);
- SIGINT, SIGTERM, or a fatal process error.

In a one-pane session launched with `exec fleet` and tmux's default `remain-on-exit off`, these exits remove the pane, window, and session. Enter and `n` are normal one-shot navigation actions, so an interactive dashboard cannot also be treated as an always-on notification service.

`Ctrl-n` and `Ctrl-p` are not Fleet navigation keys. They are parsed as control events and currently ignored. Fleet navigation is `j`/`k` or arrow keys. If Fleet receives a plain `n`, it jumps and exits.

## Current ownership

`launchTui()` in `index.ts` currently owns:

- the 500 ms fast refresh;
- the 5 second slow discovery/scrape refresh;
- status-directory watchers;
- transition memory (`notifyPrev`);
- focus-based desktop notification suppression;
- desktop notification delivery;
- status-line cache publication;
- agent snapshot publication;
- optional window rollup updates;
- terminal rendering and input.

Upstream intentionally introduced notifications as “TUI-fired” in PR #29. PR #58's “persistent tmux control-mode client” persists only for the TUI process lifetime; it is not a daemon. Upstream has no monitor/daemon PR or implementation as of v0.22.1.

## Proposed proper fix

Introduce a non-interactive, long-running `fleet monitor` service and make it the sole owner of notification and publication state.

### Monitor responsibilities

- Refresh all agent state for one tmux socket.
- Maintain work-to-stop transition history.
- Resolve real multi-client tmux focus.
- Deliver desktop notifications exactly once under existing transition semantics.
- Publish the status-line segment and agent snapshot atomically.
- Publish optional window rollups.
- Serialize watcher, timer, and control-client wake refreshes through one pipeline.
- Handle SIGINT/SIGTERM and release resources cleanly.

### Dashboard responsibilities

- Consume monitor-published state.
- Render and accept interactive commands.
- Acknowledge agents, send prompts, and switch clients.
- Fall back to live reads if the monitor is unavailable, but never deliver desktop notifications from that fallback.
- Exit freely without affecting the monitor.

### Process lifecycle

Provide lifecycle commands such as:

```text
fleet monitor
fleet monitor ensure
fleet monitor status
fleet monitor stop
```

Only one monitor may own a tmux socket. Use a per-user, per-socket lock containing the monitor PID, full tmux socket identity, tmux server PID, and start time, with stale-lock recovery.

Start or ensure the monitor when tmux starts, not only when the user first opens the dashboard. Dashboard/sidebar lifecycle must remain separate from monitor lifecycle.

For a tmux-managed implementation, use separate sessions (for example `_fleet-monitor` and the disposable `_fleet` dashboard) so dashboard exit cannot expose or terminate the monitor pane.

## Refactoring outline

1. Extract refresh, transition, notification, cache, watcher, timer, and control-client logic from `launchTui()` into `src/monitor/service.ts`.
2. Add `fleet monitor` dispatch and help text in `src/cli/router.ts`.
3. Make the monitor the sole caller of desktop delivery and normal cache publication.
4. Make the dashboard read a fresh monitor snapshot, with a read-only live fallback.
5. Add singleton/lifecycle management keyed by the full tmux socket identity.
6. Split local tmux helpers into `ensure_monitor`, `ensure_dashboard`, and `toggle_dashboard`.
7. Ensure the monitor during tmux startup/config load.
8. Consider durable transition state after process separation is stable.

## Snapshot concern

Before using `src/state/snapshot-cache.ts` as the monitor-to-dashboard channel, fix its unchanged-state throttle. The serialized payload currently includes a new `writtenAt` value before comparison, so payload equality is effectively never true and an unchanged snapshot may be rewritten every fast tick.

The dashboard needs a short monitor-health freshness threshold distinct from the existing long stale-data fallback.

## Focused completion behavior

A related but separate UX issue is that desktop notifications are suppressed for an exactly focused pane while its persistent `DONE` status can remain in the status line. The coherent behavior is to acknowledge only focused `DONE` completions before publishing state; never auto-clear `PERMIT` or `QUESTION`. This reconciliation belongs in the monitor once it becomes the state owner.

## Restart semantics

An in-memory first version matches current semantics:

- restart while an agent is `BUSY`: the first snapshot arms it, and a later stop notifies;
- restart after the agent is already `DONE`: no notification, because no transition was observed.

Persisting the previous-state map can improve restart recovery, but true exactly-once delivery across crashes requires a durable delivery/outbox design. It should be a later phase rather than mixed into the process-separation change.

## Acceptance criteria

- Desktop notifications continue after the dashboard exits through Enter, double-click, `n`, `q`, or `Esc`.
- Opening and closing a sidebar or popup does not affect monitoring.
- Exactly one monitor delivers notifications per tmux socket.
- Independent tmux sockets have independent monitors and caches.
- Focus suppression retains current multi-client behavior.
- `PERMIT` and `QUESTION` are never auto-acknowledged.
- The status line retains its live-compute fallback when no monitor is available.
- Monitor crashes or stale locks are observable through `fleet monitor status`/`fleet doctor`.

## Required tests

- Notification transition tests without a TUI.
- Dashboard exit while monitor remains alive.
- Enter/double-click/`n` do not stop monitoring.
- Singleton and stale-lock recovery.
- Multiple tmux socket isolation.
- Watcher/timer/control-wake serialization and deduplication.
- Snapshot freshness, atomicity, and unchanged-state throttling.
- Monitor restart during `BUSY` followed by completion.
- Focused versus background completion, including multiple real clients.

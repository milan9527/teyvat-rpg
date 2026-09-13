#!/usr/bin/env bash
#
# Keep the game and the unattended goal loop alive without a human in the room.
#
# Why this exists, in one sentence: everything else in this repo detaches a process, and a
# detached process that *dies* stays dead. `setsid nohup` solves the wrong half of the
# problem — it makes the client, the server and `autorun.sh` survive the terminal closing,
# which they do, but nothing notices when one of them exits on its own. The goal loop has
# already died three separate ways (a worker turn stopping its own loop, a killed parent
# taking down a shared process group, a `rm -f` of the pid file letting two workers
# overlap), and each time the answer was a human eventually running `status` and seeing
# `down`. Hours of unattended time are lost that way.
#
#   ./tools/watchdog.sh              # run in the foreground (what systemd does)
#   ./tools/watchdog.sh --once       # one pass, for testing
#
# Supervised by a *lingering* systemd user unit rather than by `setsid nohup`, because
# linger is the piece that survives a reboot and a full logout; `setsid` only survives the
# terminal. See tools/watchdog.service for the unit and how to install it.
#
# Deliberately dumb: no `claude` turns, no node, no network beyond two localhost curls. It
# has to be the most reliable thing on the box, because it is the thing with nothing
# watching it.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

LOG=/tmp/game-watchdog.log
STOP=/tmp/game-autorun.stop
DONEF=/tmp/game-autorun.done
INTERVAL="${WATCHDOG_INTERVAL:-60}"

log() { echo "$(date -Is) $*" >> "$LOG"; }

# Every child that outlives this call must be spawned through `spawn`, which closes the lock
# fd (see the flock below) in the child.
#
# This is not tidiness. An fd opened with `exec 9>` survives `exec` into the child, so the
# Vite dev server this script starts inherited fd 9 and held the watchdog's own lock for its
# entire lifetime — which is forever, by design. The effect was that every subsequent
# watchdog start failed the `flock -n` and exited, and since a clean exit under
# `Restart=always` just means "try again in 30 s", the unit sat in `activating (auto-restart)`
# with no watchdog running at all while `systemctl is-enabled` still said `enabled`. A
# supervisor that is silently absent is the exact failure this file exists to prevent, and it
# was self-inflicted by the mutex meant to protect it.
spawn() { "$@" 9>&-; }

# A pid is not liveness. A wedged Vite or a server whose event loop is blocked keeps its
# pid and its port open while serving nothing, and that reads as `up` to daemon.sh. So the
# probe is an actual request, with `--max-time` so a hung socket fails instead of hanging
# the watchdog itself.
probe() {  # url
  spawn curl -fsS --max-time 8 -o /dev/null "$1" 2>/dev/null
}

# Two consecutive failures before restarting, not one. A single miss is usually a service
# that is legitimately mid-restart — `daemon.sh restart server` takes a few seconds, and a
# watchdog that restarts a service *while it is starting* turns one blip into a loop.
declare -A misses=([client]=0 [server]=0)

# Status output is captured into a variable and matched with a `case`, never piped into
# `grep -q`. The first version of this file did pipe it, and it misread a perfectly healthy
# goal loop as `down` on its very first pass. `grep -q` exits the moment it matches, which
# SIGPIPEs the still-writing status command, and `set -o pipefail` faithfully reports that
# 141 as the pipeline's exit status — so the check inverted itself precisely when the thing
# it was looking for was present. `status` prints several lines after the one being matched,
# which is what makes the early exit possible.
status_of() {  # script args...  -> stdout, exit status ignored
  "$@" 2>/dev/null
}

check_service() {  # name  url
  local name="$1" url="$2"
  if probe "$url"; then
    if [ "${misses[$name]}" -gt 0 ]; then log "$name recovered after ${misses[$name]} miss(es)"; fi
    misses[$name]=0
    return
  fi
  misses[$name]=$(( ${misses[$name]} + 1 ))
  log "$name probe failed (${misses[$name]}) $url"
  [ "${misses[$name]}" -lt 2 ] && return
  # `start` first: it is idempotent (daemon.sh checks the pid file), so if the process is
  # simply gone this brings it back without disturbing anything else. Only a process that
  # is present *and* not answering needs the heavier restart.
  local st; st=$(status_of ./tools/daemon.sh status)
  if [[ $st == *"$name: up"* ]]; then
    log "$name is up but not answering — restarting"
    spawn ./tools/daemon.sh restart "$name" >> "$LOG" 2>&1
  else
    log "$name is down — starting"
    spawn ./tools/daemon.sh start >> "$LOG" 2>&1
  fi
  misses[$name]=0
}

check_autorun() {
  # The goal loop's two legitimate reasons not to be running. Both are respected rather
  # than overridden: a watchdog that restarts a loop somebody deliberately stopped is a
  # watchdog nobody can turn off.
  if [ -f "$DONEF" ]; then return; fi
  if [ -f "$STOP" ]; then return; fi
  # One call, reused for both tests below: `status` is cheap but it scans the log, and
  # asking twice invites the two answers to disagree.
  local st; st=$(status_of ./tools/autorun.sh status)
  if [[ $st == *'autorun: up'* ]]; then return; fi
  # `stalled` means the worker process is alive and every recent turn inside it failed. This
  # branch exists because the pid check alone kept a dead run looking healthy for 23 hours
  # after a reboot: the unit's PATH had no `claude`, so each iteration failed in a
  # millisecond and `status` said `up` because it only ever looked at the pid. A supervisor
  # that watches the wrapper and not the work is the same defect as a probe that asserts
  # nothing. Stop it and let the next pass start a fresh one, so the preflight re-runs.
  if [[ $st == *'autorun: stalled'* ]]; then
    log 'autorun is stalled (recent iterations all failed) — stopping it; next pass restarts'
    ./tools/autorun.sh stop >> "$LOG" 2>&1
    rm -f "$STOP"
    return
  fi
  # An orphaned turn means a loop died and left its `claude -p` still editing the repo.
  # Starting a fresh loop on top of that is how three of them once piled up, so clear the
  # orphans first and pick the loop up on the next pass.
  if [[ $st == *'orphaned claude turns'* ]]; then
    log 'autorun down with orphaned turns — reaping, will start next pass'
    ./tools/autorun.sh reap >> "$LOG" 2>&1
    return
  fi
  log 'autorun is down — restarting with --yolo'
  spawn ./tools/autorun.sh --yolo >> "$LOG" 2>&1
}

pass() {
  check_service client http://127.0.0.1:5173/
  check_service server http://127.0.0.1:8787/api/health
  check_autorun
}

if [ "${1:-}" = "--once" ]; then
  pass
  log 'single pass done'
  exit 0
fi

# One watchdog, enforced by the kernel — the same lesson autorun.sh already learned, and it
# was needed here within minutes of writing this file. A test instance survived the `kill`
# meant to end it (the shell had captured `setsid`'s pid, not the watchdog's) and ran
# alongside the systemd one. Two watchdogs are not merely redundant: each keeps its own
# two-strike counter, so a service that misses one probe can be "restarted" by one instance
# while the other is still counting, and the log interleaves two sets of strike numbers that
# read like one instance behaving erratically. An flock is released however the holder dies,
# including the kill that misses.
#
# `-w 20` rather than `-n`: on `systemctl --user restart` the replacement is started while
# the outgoing instance is still shutting down, so a non-blocking attempt loses a race it
# should simply have waited out — and losing it costs a full RestartSec of no supervision.
# Twenty seconds is longer than any handover here and still bounded, so a genuine second
# instance gives up rather than queueing forever.
exec 9>/tmp/game-watchdog.lock
if ! flock -w 20 9; then
  log "another watchdog already holds the lock; exiting (pid $$)"
  exit 0
fi

log "watchdog started (pid $$, every ${INTERVAL}s)"
trap 'log "watchdog stopping (signal)"; exit 0' TERM INT
# A heartbeat, so an idle log distinguishes "watchdog fine, nothing to do" from "watchdog
# died an hour ago". Hourly rather than per-pass to keep the log readable.
beat=0
while true; do
  pass
  beat=$(( beat + 1 ))
  if [ $(( beat % 60 )) -eq 0 ]; then
    log "heartbeat: $(./tools/daemon.sh status 2>&1 | tr '\n' ' ')| $(./tools/autorun.sh status 2>/dev/null | head -1)"
  fi
  sleep "$INTERVAL"
done

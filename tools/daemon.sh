#!/usr/bin/env bash
# Start the dev servers fully detached (setsid + nohup) so they outlive the shell
# that launched them — closing the terminal or the editor must not kill the game.
# Usage: tools/daemon.sh start|stop|restart|status|log [client|server]
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN="$ROOT/.run"
mkdir -p "$RUN"

start_one() {  # name  workdir  command...
  local name="$1" wd="$2"; shift 2
  local pf="$RUN/$name.pid" lf="$RUN/$name.log"
  if [ -f "$pf" ] && kill -0 "$(cat "$pf")" 2>/dev/null; then
    echo "$name already running (pid $(cat "$pf"))"; return
  fi
  # `echo $!` after `setsid` records setsid's pid, not the process it forks — so
  # the recorded pid is neither the service nor its process-group leader, and
  # `kill -TERM -$pid` on shutdown hits nothing. Let the new session leader write
  # its own pid and then exec the service, so the pid file holds both the service
  # pid and its PGID.
  ( cd "$wd" && setsid nohup bash -c 'echo $$ > "$1"; shift; exec "$@"' _ "$pf" "$@" \
      >"$lf" 2>&1 < /dev/null & )
  sleep 1.5
  echo "$name started (pid $(cat "$pf")) -> $lf"
}

start_all() {
  start_one client "$ROOT/client" npx vite --port 5173 --host 0.0.0.0
  start_one server "$ROOT/server" node src/index.js
}

stop_one() {  # name
  local pf="$RUN/$1.pid"
  [ -f "$pf" ] || { echo "$1: not running"; return; }
  local pid="$(cat "$pf")"
  kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
  echo "stopped $1 ($pid)"; rm -f "$pf"
}

case "${1:-start}" in
  start)
    start_all
    ;;
  # The server imports shared/ at startup, so any change to the shared sim or the
  # zone tables needs this; the Vite client reloads itself.
  restart)
    if [ -n "${2:-}" ]; then
      stop_one "$2"; sleep 1
      case "$2" in
        client) start_one client "$ROOT/client" npx vite --port 5173 --host 0.0.0.0 ;;
        server) start_one server "$ROOT/server" node src/index.js ;;
        *) echo "unknown service $2" ;;
      esac
    else
      stop_one client; stop_one server; sleep 1; start_all
    fi
    ;;
  log)
    tail -n "${3:-40}" "$RUN/${2:-server}.log"
    ;;
  # `stop client` used to stop the server too: this loop walked every pid file and never
  # looked at $2, even though `restart` right above it honours the argument. It reads as a
  # deliberate "stop everything" until it bites — stopping the Vite dev server to keep a
  # screenshot probe from being hot-reloaded also dropped every connected multiplayer
  # session. `restart` was fine, which is exactly why nobody noticed.
  stop)
    if [ -n "${2:-}" ]; then
      stop_one "$2"
    else
      for pf in "$RUN"/*.pid; do
        [ -f "$pf" ] || continue
        pid="$(cat "$pf")"
        # setsid puts each job in its own process group; negate to take the tree.
        kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
        echo "stopped $(basename "$pf" .pid) ($pid)"; rm -f "$pf"
      done
    fi
    ;;
  # Iterate the known services rather than the pid files that happen to exist. Keyed on the
  # files, a stopped service (whose pid file `stop` deletes) produced *no line at all*, so
  # `status` answered "client: up" alone and a reader had to notice which name was missing
  # to learn the server was down. Absent is now reported as down, which is what it means.
  status)
    for name in client server; do
      pf="$RUN/$name.pid"
      if [ -f "$pf" ] && kill -0 "$(cat "$pf")" 2>/dev/null; then
        echo "$name: up ($(cat "$pf"))"
      else
        echo "$name: down"
      fi
    done
    ;;
esac

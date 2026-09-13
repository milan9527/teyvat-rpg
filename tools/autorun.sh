#!/usr/bin/env bash
#
# Keep working toward the goal with no terminal attached.
#
# Why this exists: `/goal` installs a Stop hook, and a Stop hook can only stop *me* from
# ending a turn early. It has no power over the process. When the window closes the
# `claude` CLI gets SIGHUP and the model loop dies mid-turn, so the goal never advances
# again — even though everything launched with `setsid nohup` (the game daemons, the
# render probes) keeps running perfectly well. The daemons were detached; the *thinking*
# was not. This script detaches the thinking too, by re-invoking Claude headlessly in a
# loop from a session leader of its own.
#
#   ./tools/autorun.sh --yolo        # start (see the note on --yolo below)
#   ./tools/autorun.sh status
#   ./tools/autorun.sh log [lines]
#   ./tools/autorun.sh stop
#   ./tools/autorun.sh reap          # kill turns whose loop died and left them running
#
# `--yolo` passes --dangerously-skip-permissions. Unattended operation effectively needs
# it: in -p mode a permission prompt has no one to answer it, so the turn is denied and
# the iteration wastes itself. Without --yolo the loop still runs, but expect it to stall
# on anything outside the allowlist. Only use it because this box is a scratch dev box for
# one project; do not copy the flag to a machine that has anything you care about.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

# `claude` lives in ~/.local/bin, which is on an interactive shell's PATH and is *not* on
# the PATH a systemd user unit gets. The watchdog starts this script from that unit, so the
# first reboot turned the whole unattended run into a no-op: every iteration died with
# `claude: command not found`, 4170 of them twenty seconds apart over 23 hours, while
# `status` reported `up` the entire time because the pid file and the process were both
# perfectly healthy. Resolve the interpreter here instead of trusting the caller's PATH —
# and note the shape of the bug, which is the same one the probes keep teaching: liveness
# was asserted on the supervisor, never on the work.
export PATH="$HOME/.local/bin:$PATH"

STOP=/tmp/game-autorun.stop
LOG=/tmp/game-autorun.log
PIDF=/tmp/game-autorun.pid
DONEF=/tmp/game-autorun.done
LOCK=/tmp/game-autorun.lock

# The prompt is re-sent every iteration with --continue, so the conversation (and the
# compaction the CLI does for us) carries forward and each pass picks up the last one.
PROMPT='继续朝目标推进：创建类似原神的完整可玩RPG游戏（前后端、数据库与缓存、完整功能模块、单机与多人在线、多场景关卡、鼠标点击、3D建模与细腻画面）。

工作方式：
- 自主选择下一项最有价值的工作并完成它，不要询问、不要等待确认。
- 任何耗时任务必须用 setsid nohup ... & disown 后台运行，日志写到 /tmp。
- 改动 client/ 后跑 npm --prefix client run build；改动 shared/ 或 server/ 后跑 ./tools/daemon.sh restart server。
- 用 tools/api-check.mjs、tools/mp-check.mjs、tools/prop-cam.mjs、tools/tour.mjs 验证，不要只靠推理。
- 截图探针运行期间不要编辑 client/src（Vite HMR 会重载页面并让探针失效）。做法是：你自己在探针跑完之前先别改 client/src，跑完再改。
- 绝对不要停掉 autorun 循环（`./tools/autorun.sh stop`）。循环是严格串行的，你就是它当前的那一轮，不存在第二个 worker 会和你的探针抢 client/src；停掉它等于终止整个无人值守任务，而且没有任何东西会把它重新拉起来。
- 保持 ./tools/daemon.sh status 两个进程都是 up。
本轮结束时用一两句话说明做了什么、验证结果如何、下一步是什么。'

# Asked in its own throwaway turn, with --continue so it can see what the work turns did.
# Deliberately demands evidence and a bare verdict token: a chatty "looks good!" is the
# failure mode here, because it would end the loop on an opinion.
VERDICT_PROMPT='只做判定，不要修改任何文件。对照目标（类似原神的完整可玩RPG游戏：前后端、数据库与缓存、完整功能模块、单机与多人在线、多场景关卡、鼠标点击、3D建模与细腻画面，真实可玩而非原型，画面细腻）逐项核对当前仓库的实际状态。

只有当每一项都已实现并且有验证过的证据时，最后一行才输出 GOAL_COMPLETE；否则最后一行输出 GOAL_INCOMPLETE，并在它上面用不超过五行列出还差什么。'

# Any `claude -p` turn whose parent is init: a turn whose loop died and left it running.
#
# This is worth a dedicated check because it is the one failure mode nothing else reveals.
# A turn reparented to init keeps editing the repo, running builds and grabbing the single
# Xvfb display, while `status` — which only ever looked at the pid file — cheerfully
# reported `down`. Three of them once piled up that way and the repo thrashed for an hour.
orphan_turns() {
  local pid ppid
  for pid in $(pgrep -f 'claude -p' 2>/dev/null); do
    ppid=$(awk '{print $4}' "/proc/$pid/stat" 2>/dev/null)
    [ "$ppid" = "1" ] && echo "$pid"
  done
}

notify() {
  # There is no push channel on this box (no outbound network beyond AWS), so
  # "notification" means: a banner in the log, a done-file that survives reboots of the
  # loop, and a wall broadcast for any terminal that does happen to be attached.
  local msg="$1"
  {
    echo
    echo "############################################################"
    echo "# $msg"
    echo "# $(date -Is)"
    echo "############################################################"
  } >> "$LOG"
  wall "game autorun: $msg" 2>/dev/null
}

case "${1:-}" in
  stop)
    # A worker turn is not allowed to stop its own loop. This is not a hypothetical: the
    # loop died twice this way, and the log records the worker's own reasoning — "后台
    # autorun 循环目前是停的(我为了避免和探针并发改 client/src 而停掉了它)". It stopped the
    # loop to keep a screenshot probe from being invalidated by a concurrent editor, which
    # sounds prudent and is actually self-defeating: the loop is strictly sequential, so the
    # only editor that could race the probe *is the turn making the decision*. There is
    # never a second worker to protect the probe from, and the cost of the mistake is the
    # whole unattended run — after a `touch $STOP` nothing restarts it, so the goal simply
    # stops advancing until a human notices hours later.
    #
    # `AUTORUN_CHILD=1` is exported into the worker at the bottom of this file and inherited
    # by its `claude -p`, so the variable is a reliable "am I inside the loop" test that
    # costs nothing. An interactive stop does not have it.
    if [ "${AUTORUN_CHILD:-}" = "1" ] && [ "${AUTORUN_FORCE_STOP:-}" != "1" ]; then
      echo "refusing: a worker turn cannot stop its own loop." >&2
      echo "  The loop runs one turn at a time, so nothing else is editing the repo right" >&2
      echo "  now — just don't edit client/src yourself while your probe is running." >&2
      echo "  If you really mean it: AUTORUN_FORCE_STOP=1 ./tools/autorun.sh stop" >&2
      echo "=== refused a stop from inside a worker turn $(date -Is)" >> "$LOG"
      exit 1
    fi
    touch "$STOP"
    [ -f "$PIDF" ] && kill "$(cat "$PIDF")" 2>/dev/null
    # The worker's TERM handler takes its own turn down with it, so the turn should be gone
    # within a few seconds; give it that long before reporting what survived.
    sleep 3
    echo "stop requested; the running turn was signalled too"
    left=$(orphan_turns)
    [ -n "$left" ] && echo "still running (orphaned): $left — ./tools/autorun.sh reap"
    exit 0
    ;;
  status)
    # A live pid is not progress. `up` used to mean nothing more than "the worker process
    # exists", which is precisely what it kept reporting for 23 hours while every turn
    # inside it died on a missing binary. So the recent iterations are read too, and a
    # worker whose last few all failed says `stalled` rather than `up` — a distinct word,
    # because the watchdog matches on `autorun: up` and would otherwise keep a corpse warm.
    #
    # `ok` defaults to 1 so the in-flight iteration (no verdict line yet) is not counted as
    # a failure, and at least three finished-and-failed iterations are required: a single
    # transient API error must not get the loop restarted out from under its own turn.
    recent=$(awk '/^=== iteration /{n++; ok[n]=1}
                  /^iteration [0-9]+ failed$/{if (n) ok[n]=0}
                  END{lo=(n>5?n-4:1); c=0; f=0;
                      for(i=lo;i<=n;i++){c++; if(!ok[i]) f++}
                      print f, c}' "$LOG" 2>/dev/null || echo "0 0")
    fails=${recent% *}; seen=${recent#* }
    if [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; then
      state=up
      [ "${fails:-0}" -ge 3 ] && [ "${fails:-0}" = "${seen:-0}" ] && state=stalled
      echo "autorun: $state ($(cat "$PIDF"))  iterations=$(grep -c '^=== iteration' "$LOG" 2>/dev/null || echo 0)"
      if [ "$state" = stalled ]; then
        echo "  the last $seen iterations all failed — the worker is alive but doing nothing."
        echo "  last error: $(grep -E 'not found|Error|error' "$LOG" 2>/dev/null | tail -1)"
      fi
    else
      echo "autorun: down  iterations=$(grep -c '^=== iteration' "$LOG" 2>/dev/null || echo 0)"
    fi
    orphans=$(orphan_turns)
    if [ -n "$orphans" ]; then
      echo
      echo "WARNING: orphaned claude turns (parent died, still editing the repo):"
      for o in $orphans; do
        echo "  $o  up $(ps -o etime= -p "$o" 2>/dev/null | tr -d ' ')"
      done
      echo "  ./tools/autorun.sh reap   # terminate them"
    fi
    if [ -f "$DONEF" ]; then
      echo
      echo "GOAL REPORTED COMPLETE — $(head -1 "$DONEF")"
      echo "  full verdict: $DONEF"
    fi
    # The last per-iteration summary is the thing actually worth reading, so surface it
    # rather than making the caller go grep the log.
    if [ -f "$LOG" ]; then
      echo
      echo "last iteration summary:"
      awk '/^--- summary /{f=NR} {a[NR]=$0} END{if(f) for(i=f;i<=NR;i++) print "  " a[i]}' "$LOG" | tail -20
    fi
    exit 0
    ;;
  log)
    tail -n "${2:-60}" "$LOG"
    exit 0
    ;;
  reap)
    # Kill orphaned turns only — never the turn belonging to a live loop, which is doing
    # exactly what it should. SIGTERM rather than SIGKILL so the CLI can finish writing the
    # file it is on: an interrupted multi-file edit leaves the build broken for whatever
    # runs next, which is a worse problem than the orphan.
    found=$(orphan_turns)
    if [ -z "$found" ]; then
      echo "no orphaned turns"
    else
      for o in $found; do
        echo "terminating orphaned turn $o"
        kill -TERM "$o" 2>/dev/null
      done
      echo "=== reaped orphaned turns: $found  $(date -Is)" >> "$LOG"
    fi
    exit 0
    ;;
esac

YOLO=()
[ "${1:-}" = "--yolo" ] && YOLO=(--dangerously-skip-permissions)

if [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; then
  echo "already up ($(cat "$PIDF")); ./tools/autorun.sh stop first"
  exit 1
fi
rm -f "$STOP" "$DONEF"

# The worker: one `claude -p` per iteration, forever, until the goal check passes or the
# stop sentinel appears. Sequential rather than parallel on purpose — two Claudes editing
# this repo at once would fight over the Vite build and over the single Xvfb display the
# probes need.
# The pid of the claude turn currently running, so the signal handlers can reach it.
CHILD=""

cleanup() {
  # Take the turn down with us. Without this the child is reparented to init and keeps
  # editing the repo after its loop is gone: three orphaned turns accumulated that way
  # during one session of restarts, all writing to the same files, all running builds, all
  # competing for the single Xvfb display the render probes need. That is far worse than a
  # loop that is merely stopped, because nothing in `status` reveals it.
  [ -n "$CHILD" ] && kill -TERM "$CHILD" 2>/dev/null
  [ "$(cat "$PIDF" 2>/dev/null)" = "$$" ] && rm -f "$PIDF"
}

# Run one claude turn as a background job and wait for it, rather than in the foreground.
# Bash defers a trapped signal until its foreground child exits, so a foreground turn made
# `stop` take up to a whole iteration to land — long enough for a fresh worker to start and
# for the two to overlap. Backgrounding plus `wait` lets the handler run immediately.
turn() {
  "$@" >> "$LOG" 2>&1 &
  CHILD=$!
  wait "$CHILD"
  local rc=$?
  CHILD=""
  return $rc
}

worker() {
  # One worker, enforced by the kernel rather than by a pid file. A pid file cannot be
  # made race-free here: `stop` and a subsequent start can interleave, and a stale file
  # left by a killed worker reads as "free" while its orphaned turn is still running. An
  # flock is released automatically when the holder dies, however it dies.
  exec 9>"$LOCK"
  if ! flock -n 9; then
    echo "=== another worker already holds $LOCK; exiting $(date -Is)" >> "$LOG"
    exit 1
  fi
  echo "$$" > "$PIDF"
  trap 'cleanup; exit 143' TERM INT
  trap cleanup EXIT
  # Fail loudly at the door instead of quietly forever. A loop that cannot find its own
  # interpreter has nothing to do but burn twenty seconds and try again, and it will keep
  # doing that until someone reads the log — so refuse to start, which at least makes
  # `status` say `down` and the watchdog log a restart attempt every minute.
  if ! command -v claude >/dev/null 2>&1; then
    notify "cannot start: \`claude\` is not on PATH ($PATH)"
    exit 1
  fi
  local n=0 streak=0
  while [ ! -f "$STOP" ]; do
    n=$((n + 1))
    {
      echo
      echo "=== iteration $n  $(date -Is)"
    } >> "$LOG"
    # --continue resumes the newest conversation in this directory; on the very first
    # iteration there may be none, so fall back to a fresh one.
    if turn claude -p "${YOLO[@]}" --continue "$PROMPT" \
      || turn claude -p "${YOLO[@]}" "$PROMPT"; then
      streak=0
    else
      echo "iteration $n failed" >> "$LOG"
      streak=$((streak + 1))
    fi
    echo "--- summary of iteration $n ($(date -Is)) is the text above" >> "$LOG"
    [ -f "$STOP" ] && break
    # Give up rather than spin. Five failures in a row is not a flaky API call, it is a
    # broken environment, and the loop's own history is the argument: nothing about a
    # continuously failing worker was visible from the outside, so it ran for a day. Exiting
    # hands the problem to the watchdog, whose restart re-runs the preflight above and
    # whose log records the attempt.
    if [ "$streak" -ge 5 ]; then
      notify "$streak consecutive iterations failed — exiting so the watchdog restarts a clean worker"
      exit 1
    fi

    # Completion check. Every fifth iteration, not every one: the check costs a full turn
    # of its own, and on a goal this open-ended the answer changes over hours, not minutes.
    if [ $((n % 5)) -eq 0 ]; then
      : > "$LOG.verdict"
      claude -p "${YOLO[@]}" --continue "$VERDICT_PROMPT" > "$LOG.verdict" 2>&1 &
      CHILD=$!
      wait "$CHILD"
      CHILD=""
      echo "--- goal check after iteration $n" >> "$LOG"
      cat "$LOG.verdict" >> "$LOG"
      # Match only on the final line, so the token appearing inside the prose of the
      # "what is still missing" list cannot end the loop by accident.
      if [ "$(tail -1 "$LOG.verdict" | tr -d '[:space:]')" = "GOAL_COMPLETE" ]; then
        cp "$LOG.verdict" "$DONEF"
        notify "GOAL COMPLETE after $n iterations"
        break
      fi
    fi
    # A short breather so a hard-failing loop cannot spin the box or burn tokens flat out.
    sleep 20
  done
  [ -f "$STOP" ] && notify "stopped on request after $n iterations"
}

if [ "${AUTORUN_CHILD:-}" = "1" ]; then
  worker
else
  AUTORUN_CHILD=1 setsid nohup "$0" "${1:-}" >/dev/null 2>&1 </dev/null &
  disown
  sleep 1
  echo "autorun started, logging to $LOG"
  echo "  ./tools/autorun.sh status | log | stop"
fi

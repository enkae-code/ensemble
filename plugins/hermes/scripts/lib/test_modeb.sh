#!/bin/bash
set -euo pipefail

declare -r SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
declare -r MODEB_PATH="${SCRIPT_DIR}/modeb.sh"
declare -r COMPANION_PATH="${SCRIPT_DIR}/../hermes-companion.mjs"
declare -r TMP_ROOT="${TMPDIR:-/tmp}"

test_dir=""
tracked_pids=()
case_failures=0
before_temp_list=""

track_pid() {
  local pid="${1:-}"

  if [[ "$pid" =~ ^[1-9][0-9]*$ ]]; then
    tracked_pids+=("$pid")
  fi
}

process_alive() {
  local pid="$1"
  local process_state

  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  process_state="$(ps -o stat= -p "$pid" 2>/dev/null | tr -d '[:space:]')" || return 1
  [[ -n "$process_state" && "$process_state" != Z* ]]
}

process_group_alive() {
  local pgid="$1"

  [[ "$pgid" =~ ^[1-9][0-9]*$ ]] || return 1
  ps -o stat= -g "$pgid" 2>/dev/null | awk 'NF && $1 !~ /^Z/ { found = 1 } END { exit found ? 0 : 1 }'
}

wait_for_pid_dead() {
  local pid="$1"
  local timeout_seconds="$2"
  local start_epoch

  start_epoch="$(date +%s)"
  while process_alive "$pid"; do
    if (( $(date +%s) - start_epoch >= timeout_seconds )); then
      return 1
    fi
    sleep 1
  done
}

wait_for_process_group_dead() {
  local pgid="$1"
  local timeout_seconds="$2"
  local start_epoch

  start_epoch="$(date +%s)"
  while process_group_alive "$pgid"; do
    if (( $(date +%s) - start_epoch >= timeout_seconds )); then
      return 1
    fi
    sleep 1
  done
}

kill_tracked_pids() {
  local pid

  for pid in "${tracked_pids[@]:-}"; do
    if process_alive "$pid"; then
      kill "$pid" 2>/dev/null || true
    fi
  done

  sleep 0.2

  for pid in "${tracked_pids[@]:-}"; do
    if process_alive "$pid"; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
    wait "$pid" 2>/dev/null || true
  done
}

cleanup() {
  local saved_status="$?"
  set +e

  kill_tracked_pids
  if [[ -n "$test_dir" ]]; then
    rm -rf "$test_dir"
  fi

  exit "$saved_status"
}

trap cleanup EXIT

print_case_result() {
  local case_name="$1"
  local status="$2"

  printf '%s %s\n' "$status" "$case_name"
}

run_case() {
  local case_name="$1"
  shift

  if "$@"; then
    print_case_result "$case_name" "PASS"
    return 0
  fi

  print_case_result "$case_name" "FAIL"
  case_failures=$((case_failures + 1))
  return 0
}

write_caps() {
  local caps_path="$1"
  local max_turns="$2"
  local max_cost_usd="$3"
  local idle_timeout_seconds="$4"
  local max_wall_seconds="$5"
  local cost_brake_enabled="$6"

  python3 -c '
import json
import sys

payload = {
    "max_turns": int(sys.argv[2]),
    "max_cost_usd": float(sys.argv[3]),
    "idle_timeout_seconds": int(sys.argv[4]),
    "max_wall_seconds": int(sys.argv[5]),
    "min_iteration_floor": 1,
    "confidence_threshold": 80,
    "saturation_threshold": 2,
    "cost_brake_enabled": sys.argv[6] == "true",
}
with open(sys.argv[1], "w", encoding="utf-8") as handle:
    json.dump(payload, handle, indent=2, sort_keys=True)
    handle.write("\n")
' "$caps_path" "$max_turns" "$max_cost_usd" "$idle_timeout_seconds" "$max_wall_seconds" "$cost_brake_enabled"
}

initialize_state_db() {
  local db_path="$1"

  python3 -c '
import sqlite3
import sys

connection = sqlite3.connect(sys.argv[1])
connection.executescript(
    """
    CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        started_at REAL NOT NULL,
        estimated_cost_usd REAL,
        actual_cost_usd REAL,
        output_tokens INTEGER DEFAULT 0,
        api_call_count INTEGER DEFAULT 0
    );
    CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        timestamp REAL NOT NULL
    );
    """
)
connection.commit()
' "$db_path"
}

insert_session_row() {
  local db_path="$1"
  local session_id="$2"
  local launch_epoch="$3"
  local api_call_count="$4"
  local output_tokens="$5"
  local message_content="$6"

  python3 -c '
import sqlite3
import sys

connection = sqlite3.connect(sys.argv[1])
connection.execute(
    """
    INSERT OR REPLACE INTO sessions (
        id,
        source,
        started_at,
        estimated_cost_usd,
        output_tokens,
        api_call_count
    ) VALUES (?, ?, ?, ?, ?, ?)
    """,
    (sys.argv[2], "cli", float(sys.argv[3]), 0.0, int(sys.argv[5]), int(sys.argv[4])),
)
connection.execute(
    """
    INSERT INTO messages (
        session_id,
        role,
        content,
        timestamp
    ) VALUES (?, ?, ?, ?)
    """,
    (sys.argv[2], "user", sys.argv[6], float(sys.argv[3])),
)
connection.commit()
' "$db_path" "$session_id" "$launch_epoch" "$api_call_count" "$output_tokens" "$message_content"
}

update_session_metrics() {
  local db_path="$1"
  local session_id="$2"
  local api_call_count="$3"
  local output_tokens="$4"

  python3 -c '
import sqlite3
import sys

connection = sqlite3.connect(sys.argv[1])
connection.execute(
    "UPDATE sessions SET api_call_count = ?, output_tokens = ? WHERE id = ?",
    (int(sys.argv[3]), int(sys.argv[4]), sys.argv[2]),
)
connection.commit()
' "$db_path" "$session_id" "$api_call_count" "$output_tokens"
}

write_hermes_stub() {
  local stub_path="$1"

  cat > "$stub_path" <<'EOF'
#!/bin/bash
set -euo pipefail

payload=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -z)
      shift
      payload="${1:-}"
      ;;
  esac
  shift || break
done

marker="$(python3 -c '
import re
import sys

match = re.search(r"\[modeb-launch-id:[^\]]+\]", sys.argv[1])
print(match.group(0) if match else "")
' "$payload")"

python3 -c '
import sqlite3
import sys
import time

connection = sqlite3.connect(sys.argv[1])
connection.execute(
    """
    INSERT OR REPLACE INTO sessions (
        id,
        source,
        started_at,
        estimated_cost_usd,
        output_tokens,
        api_call_count
    ) VALUES (?, ?, ?, ?, ?, ?)
    """,
    ("stub-row", "cli", time.time(), 0.0, 10, 1),
)
connection.execute(
    """
    INSERT INTO messages (
        session_id,
        role,
        content,
        timestamp
    ) VALUES (?, ?, ?, ?)
    """,
    ("stub-row", "user", sys.argv[2], time.time()),
)
connection.commit()
' "$HERMES_STATE_DB" "$marker"

sleep 1
python3 -c '
import sqlite3
import sys

connection = sqlite3.connect(sys.argv[1])
connection.execute("UPDATE sessions SET api_call_count = ?, output_tokens = ? WHERE id = ?", (2, 20, "stub-row"))
connection.commit()
' "$HERMES_STATE_DB"

printf 'MODEB_STUB_OK\n'
EOF

  chmod +x "$stub_path"
}

write_prelaunch_hook() {
  local hook_path="$1"
  local mode="$2"
  local hook_job_id="${3:-hook-job}"

  cat > "$hook_path" <<EOF
#!/bin/bash
set -euo pipefail

python3 -c 'import json, sys; json.load(sys.stdin)' >/dev/null
if [[ "$mode" == "refuse" ]]; then
  printf 'budget refused\n' >&2
  exit 7
fi
printf '{"job_id":"%s"}\n' "$hook_job_id"
EOF

  chmod +x "$hook_path"
}

write_marker_hook() {
  local hook_path="$1"
  local marker_path="$2"
  local exit_code="${3:-0}"

  cat > "$hook_path" <<EOF
#!/bin/bash
set -euo pipefail

cat >> "$marker_path"
exit "$exit_code"
EOF

  chmod +x "$hook_path"
}

write_release_status_hook() {
  local hook_path="$1"
  local status_path="$2"

  cat > "$hook_path" <<EOF
#!/bin/bash
set -euo pipefail

python3 -c 'import json, sys; print(json.load(sys.stdin).get("status", ""))' >> "$status_path"
EOF

  chmod +x "$hook_path"
}

write_long_running_hermes_stub() {
  local stub_path="$1"

  cat > "$stub_path" <<'EOF'
#!/bin/bash
set -euo pipefail

payload=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -z)
      shift
      payload="${1:-}"
      ;;
  esac
  shift || break
done

marker="$(python3 -c '
import re
import sys

match = re.search(r"\[modeb-launch-id:[^\]]+\]", sys.argv[1])
print(match.group(0) if match else "")
' "$payload")"
session_id="stub-$$"

if [[ -n "${MODEB_STUB_PID_FILE:-}" ]]; then
  printf '%s\n' "$$" > "$MODEB_STUB_PID_FILE"
fi

python3 -c '
import sqlite3
import sys
import time

connection = sqlite3.connect(sys.argv[1])
connection.execute(
    """
    INSERT OR REPLACE INTO sessions (
        id,
        source,
        started_at,
        estimated_cost_usd,
        output_tokens,
        api_call_count
    ) VALUES (?, ?, ?, ?, ?, ?)
    """,
    (sys.argv[2], "cli", time.time(), 0.0, 10, 1),
)
connection.execute(
    """
    INSERT INTO messages (
        session_id,
        role,
        content,
        timestamp
    ) VALUES (?, ?, ?, ?)
    """,
    (sys.argv[2], "user", sys.argv[3], time.time()),
)
connection.commit()
' "$HERMES_STATE_DB" "$session_id" "$marker"

count=1
trap 'exit 143' TERM INT
while true; do
  python3 -c '
import sqlite3
import sys

connection = sqlite3.connect(sys.argv[1])
connection.execute(
    "UPDATE sessions SET api_call_count = ?, output_tokens = ? WHERE id = ?",
    (int(sys.argv[3]), int(sys.argv[3]) * 10, sys.argv[2]),
)
connection.commit()
' "$HERMES_STATE_DB" "$session_id" "$count"
  count=$((count + 1))
  sleep 1
done
EOF

  chmod +x "$stub_path"
}

prepare_case_env() {
  local case_name="$1"
  local cost_brake_enabled="$2"
  local case_dir="$test_dir/$case_name"

  mkdir -p "$case_dir/bin" "$case_dir/home/.hermes" "$case_dir/hooks" "$case_dir/workdir" "$case_dir/state"
  write_caps "$case_dir/state/hermes_caps.json" 10 5 6 30 "$cost_brake_enabled"
  initialize_state_db "$case_dir/state.db"
  write_hermes_stub "$case_dir/bin/hermes"
  printf '%s\n' "$case_dir"
}

find_job_file() {
  local case_dir="$1"
  local job_id="$2"
  local state_root="$case_dir/home/.claude/plugins/data/ensemble-hermes/state"

  find "$state_root" -path "*/jobs/$job_id.json" -print -quit 2>/dev/null
}

read_job_field() {
  local job_file="$1"
  local field_path="$2"

  python3 - "$job_file" "$field_path" <<'PY'
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as handle:
    value = json.load(handle)

for part in sys.argv[2].split("."):
    if not isinstance(value, dict):
        value = None
        break
    value = value.get(part)

print("" if value is None else value)
PY
}

wait_for_job_targets() {
  local case_dir="$1"
  local job_id="$2"
  local output_path="$3"
  local job_file
  local modeb_pid
  local session_child_pid
  local start_epoch

  start_epoch="$(date +%s)"
  while true; do
    job_file="$(find_job_file "$case_dir" "$job_id")"
    if [[ -n "$job_file" ]]; then
      modeb_pid="$(read_job_field "$job_file" modebPid)"
      session_child_pid="$(read_job_field "$job_file" sessionChildPid)"
      if [[ "$modeb_pid" =~ ^[1-9][0-9]*$ && "$session_child_pid" =~ ^[1-9][0-9]*$ ]]; then
        printf '%s\n' "$job_file" > "$output_path"
        return 0
      fi
    fi

    if (( $(date +%s) - start_epoch >= 15 )); then
      return 1
    fi
    sleep 1
  done
}

wait_for_file_line() {
  local file_path="$1"
  local expected_line="$2"
  local timeout_seconds="$3"
  local start_epoch

  start_epoch="$(date +%s)"
  while true; do
    if [[ -f "$file_path" ]] && grep -qx "$expected_line" "$file_path"; then
      return 0
    fi
    if (( $(date +%s) - start_epoch >= timeout_seconds )); then
      return 1
    fi
    sleep 1
  done
}

run_modeb() {
  local case_dir="$1"
  local output_path="$2"
  local task="$3"
  shift 3

  env \
    HOME="$case_dir/home" \
    HERMES_CAPS_PATH="$case_dir/state/hermes_caps.json" \
    HERMES_STATE_DB="$case_dir/state.db" \
    HERMES_WORKDIR="$case_dir/workdir" \
    HERMES_MODEB_KILL_GRACE_SECONDS=1 \
    PATH="$case_dir/bin:$PATH" \
    "$@" \
    bash "$MODEB_PATH" \
      --model opencode-go/glm-5.1 \
      --account default \
      --session "modeb-test-$(basename "$case_dir")" \
      --max-turns 10 \
      --max-cost-usd 5 \
      --idle-timeout 6 \
      --max-wall-seconds 30 \
      "$task" \
      > "$output_path" 2>&1
}

task_with_report() {
  local report_path="$1"
  local marker="$2"

  printf 'RESEARCH TASK: modeb hook %s\nREPORT DESTINATION: %s\n%s\n' "$marker" "$report_path" "$marker"
}

case_prelaunch_refuses_partial_report() {
  local case_dir
  local output_path
  local report_path
  local exit_code=0

  case_dir="$(prepare_case_env prelaunch-refuse true)"
  output_path="$case_dir/output.txt"
  report_path="$case_dir/report.md"
  write_prelaunch_hook "$case_dir/hooks/prelaunch" refuse

  set +e
  run_modeb "$case_dir" "$output_path" "$(task_with_report "$report_path" MODEB_REFUSE)" \
    HERMES_HOOK_PRELAUNCH="$case_dir/hooks/prelaunch"
  exit_code="$?"
  set -e

  [[ "$exit_code" -eq 2 ]] || return 1
  grep -q 'preflight refused modeb launch' "$output_path" || return 1
  grep -q 'Reason: preflight-cost-brake-refused' "$report_path"
}

case_prelaunch_allows() {
  local case_dir
  local output_path

  case_dir="$(prepare_case_env prelaunch-allow true)"
  output_path="$case_dir/output.txt"
  write_prelaunch_hook "$case_dir/hooks/prelaunch" allow "hook-allow"

  run_modeb "$case_dir" "$output_path" "MODEB_ALLOW" \
    HERMES_HOOK_PRELAUNCH="$case_dir/hooks/prelaunch"

  grep -q '^status=completed$' "$output_path" || return 1
  grep -q '^job_id=hook-allow$' "$output_path"
}

case_touch_release_hooks_invoked() {
  local case_dir
  local output_path
  local touch_log
  local release_log

  case_dir="$(prepare_case_env touch-release false)"
  output_path="$case_dir/output.txt"
  touch_log="$case_dir/touch.log"
  release_log="$case_dir/release.log"
  write_marker_hook "$case_dir/hooks/touch" "$touch_log" 0
  write_marker_hook "$case_dir/hooks/release" "$release_log" 0

  run_modeb "$case_dir" "$output_path" "MODEB_TOUCH_RELEASE" \
    HERMES_HOOK_JOB_TOUCH="$case_dir/hooks/touch" \
    HERMES_HOOK_JOB_RELEASE="$case_dir/hooks/release"

  grep -q '^status=completed$' "$output_path" || return 1
  grep -q '"status": "running"' "$touch_log" || return 1
  grep -q '"status": "completed"' "$release_log"
}

case_no_hooks_clean_run() {
  local case_dir
  local output_path

  case_dir="$(prepare_case_env no-hooks false)"
  output_path="$case_dir/output.txt"

  run_modeb "$case_dir" "$output_path" "MODEB_NO_HOOKS"

  grep -q '^status=completed$' "$output_path"
}

case_fail_closed_without_prelaunch_hook() {
  local case_dir
  local output_path
  local report_path
  local exit_code=0

  case_dir="$(prepare_case_env fail-closed true)"
  output_path="$case_dir/output.txt"
  report_path="$case_dir/report.md"

  set +e
  run_modeb "$case_dir" "$output_path" "$(task_with_report "$report_path" MODEB_FAIL_CLOSED)"
  exit_code="$?"
  set -e

  [[ "$exit_code" -eq 2 ]] || return 1
  grep -q 'prelaunch hook unavailable; refusing cost-braked launch' "$output_path" || return 1
  grep -q 'Reason: preflight-cost-brake-refused' "$report_path"
}

case_touch_failure_best_effort() {
  local case_dir
  local output_path
  local touch_log

  case_dir="$(prepare_case_env touch-fails false)"
  output_path="$case_dir/output.txt"
  touch_log="$case_dir/touch.log"
  write_marker_hook "$case_dir/hooks/touch" "$touch_log" 9

  run_modeb "$case_dir" "$output_path" "MODEB_TOUCH_FAILS" \
    HERMES_HOOK_JOB_TOUCH="$case_dir/hooks/touch"

  grep -q '^status=completed$' "$output_path"
}

case_activity_touch_hook() {
  local case_dir="$test_dir/activity-touch"
  local db_path="$case_dir/state.db"
  local preexisting_ids_path="$case_dir/preexisting_ids"
  local reason_path="$case_dir/reason"
  local reason_lock_path="$case_dir/reason.lock"
  local touch_log="$case_dir/touch.log"
  local launch_epoch
  local launch_marker="[modeb-launch-id:activity-touch]"
  local monitor_pid
  local monitor_exit=0
  local target_pid
  local touch_count

  mkdir -p "$case_dir"
  initialize_state_db "$db_path"
  : > "$preexisting_ids_path"
  write_marker_hook "$case_dir/touch" "$touch_log" 0
  launch_epoch="$(date +%s)"
  insert_session_row "$db_path" "activity-row" "$launch_epoch" 1 10 "$launch_marker"

  ( sleep 30 ) &
  target_pid="$!"

  HERMES_STATE_DB="$db_path" \
  HERMES_HOOK_JOB_TOUCH="$case_dir/touch" \
  bash -c '
    source "$1"
    reason_path="$2"
    reason_lock_path="$3"
    log_path="$4"
    activity_monitor_loop "$5" "activity-job" 6 20 99 "$6" "$7" "$8" "activity-session"
  ' bash "$MODEB_PATH" "$reason_path" "$reason_lock_path" "$case_dir/log" "$target_pid" "$launch_epoch" "$preexisting_ids_path" "$launch_marker" &
  monitor_pid="$!"

  sleep 3
  update_session_metrics "$db_path" "activity-row" 2 20

  set +e
  wait "$monitor_pid"
  monitor_exit="$?"
  set -e

  touch_count="$(wc -l < "$touch_log")"

  if kill -0 "$target_pid" 2>/dev/null; then
    kill "$target_pid" 2>/dev/null || true
    wait "$target_pid" 2>/dev/null || true
  fi

  [[ "$monitor_exit" -eq 0 ]] || return 1
  grep -q '^idle-killed$' "$reason_path" || return 1
  [[ "$touch_count" -ge 2 ]]
}

case_misconfigured_prelaunch_hook_refuses() {
  local case_dir
  local output_path
  local report_path
  local exit_code=0

  case_dir="$(prepare_case_env prelaunch-misconfigured false)"
  output_path="$case_dir/output.txt"
  report_path="$case_dir/report.md"
  printf '#!/bin/bash\nexit 0\n' > "$case_dir/hooks/not-executable"

  set +e
  run_modeb "$case_dir" "$output_path" "$(task_with_report "$report_path" MODEB_BAD_PRELAUNCH)" \
    HERMES_HOOK_PRELAUNCH="$case_dir/hooks/not-executable"
  exit_code="$?"
  set -e

  [[ "$exit_code" -eq 2 ]] || return 1
  grep -q 'prelaunch hook misconfigured; refusing launch' "$output_path" || return 1
  grep -q "$case_dir/hooks/not-executable" "$report_path"
}

case_companion_path_expansion() {
  local case_dir

  case_dir="$(prepare_case_env companion-path-expansion false)"

  HOME="$case_dir/home" node --input-type=module - "$COMPANION_PATH" "$case_dir/home" <<'EOF'
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const companionPath = process.argv[2];
const homeDir = process.argv[3];
const { resolveConfiguredPath } = await import(pathToFileURL(companionPath).href);

assert.equal(resolveConfiguredPath("~/caps.json"), path.join(homeDir, "caps.json"));
assert.equal(resolveConfiguredPath("$HOME/caps.json"), path.join(homeDir, "caps.json"));
EOF
}

case_companion_cancel_releases_cancelled() {
  local case_dir
  local start_output
  local cancel_output
  local job_id
  local worker_pid
  local job_file_path
  local job_file
  local modeb_pid
  local session_child_pid
  local stub_pid
  local release_status_path

  case_dir="$(prepare_case_env companion-cancel false)"
  start_output="$case_dir/start.txt"
  cancel_output="$case_dir/cancel.txt"
  release_status_path="$case_dir/release-status.txt"
  write_long_running_hermes_stub "$case_dir/bin/hermes"
  write_release_status_hook "$case_dir/hooks/release" "$release_status_path"

  env \
    HOME="$case_dir/home" \
    HERMES_STATE_DB="$case_dir/state.db" \
    HERMES_WORKDIR="$case_dir/workdir" \
    HERMES_HOOK_JOB_RELEASE="$case_dir/hooks/release" \
    HERMES_MODEB_KILL_GRACE_SECONDS=1 \
    MODEB_STUB_PID_FILE="$case_dir/stub.pid" \
    PATH="$case_dir/bin:$PATH" \
    node "$COMPANION_PATH" research \
      --background \
      --cwd "$case_dir/workdir" \
      --report "$case_dir/report.md" \
      --idle 30 \
      --wall 60 \
      "MODEB_COMPANION_CANCEL" \
      > "$start_output" 2>&1

  job_id="$(awk '/^started / { print $2; exit }' "$start_output")"
  worker_pid="$(awk '/^pid / { print $2; exit }' "$start_output")"
  [[ -n "$job_id" && "$worker_pid" =~ ^[1-9][0-9]*$ ]] || return 1
  track_pid "$worker_pid"

  job_file_path="$case_dir/job-file-path.txt"
  wait_for_job_targets "$case_dir" "$job_id" "$job_file_path" || return 1
  job_file="$(< "$job_file_path")"
  modeb_pid="$(read_job_field "$job_file" modebPid)"
  session_child_pid="$(read_job_field "$job_file" sessionChildPid)"
  stub_pid=""
  for _ in {1..15}; do
    if [[ -s "$case_dir/stub.pid" ]]; then
      stub_pid="$(< "$case_dir/stub.pid")"
      break
    fi
    sleep 1
  done
  track_pid "$modeb_pid"
  track_pid "$session_child_pid"
  track_pid "$stub_pid"

  env \
    HOME="$case_dir/home" \
    HERMES_STATE_DB="$case_dir/state.db" \
    HERMES_WORKDIR="$case_dir/workdir" \
    HERMES_HOOK_JOB_RELEASE="$case_dir/hooks/release" \
    HERMES_MODEB_KILL_GRACE_SECONDS=1 \
    MODEB_STUB_PID_FILE="$case_dir/stub.pid" \
    PATH="$case_dir/bin:$PATH" \
    node "$COMPANION_PATH" cancel \
      --cwd "$case_dir/workdir" \
      "$job_id" \
      > "$cancel_output" 2>&1

  grep -q "Cancelled research $job_id" "$cancel_output" || return 1
  wait_for_process_group_dead "$session_child_pid" 8 || return 1
  wait_for_pid_dead "$worker_pid" 8 || return 1
  wait_for_pid_dead "$modeb_pid" 8 || return 1
  [[ -z "$stub_pid" ]] || wait_for_pid_dead "$stub_pid" 8 || return 1
  wait_for_file_line "$release_status_path" "cancelled" 8
}

case_no_leaks() {
  local after_temp_list="$test_dir/after-temp.txt"
  local new_temp_list="$test_dir/new-temp.txt"

  find "$TMP_ROOT" -maxdepth 1 -name 'hermes-modeb.*' -print | sort > "$after_temp_list"
  comm -13 "$before_temp_list" "$after_temp_list" > "$new_temp_list"
  [[ ! -s "$new_temp_list" ]]
}

main() {
  test_dir="$(mktemp -d "$TMP_ROOT/modeb-test.XXXXXX")"
  before_temp_list="$test_dir/before-temp.txt"
  find "$TMP_ROOT" -maxdepth 1 -name 'hermes-modeb.*' -print | sort > "$before_temp_list"

  run_case "case-1-prelaunch-refuses-partial-report" case_prelaunch_refuses_partial_report
  run_case "case-2-prelaunch-allows" case_prelaunch_allows
  run_case "case-3-touch-release-hooks" case_touch_release_hooks_invoked
  run_case "case-4-no-hooks-clean-run" case_no_hooks_clean_run
  run_case "case-5-fail-closed-without-prelaunch-hook" case_fail_closed_without_prelaunch_hook
  run_case "case-6-touch-failure-best-effort" case_touch_failure_best_effort
  run_case "case-7-activity-touch-hook" case_activity_touch_hook
  run_case "case-8-misconfigured-prelaunch-hook-refuses" case_misconfigured_prelaunch_hook_refuses
  run_case "case-9-companion-path-expansion" case_companion_path_expansion
  run_case "case-10-companion-cancel-releases-cancelled" case_companion_cancel_releases_cancelled
  run_case "case-11-no-leaks" case_no_leaks

  if [[ "$case_failures" -gt 0 ]]; then
    return 1
  fi

  return 0
}

main "$@"

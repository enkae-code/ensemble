#!/bin/bash
set -euo pipefail

declare -r SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
declare -r MODEB_PATH="${SCRIPT_DIR}/modeb.sh"
declare -r TMP_ROOT="${TMPDIR:-/tmp}"

test_dir=""
case_failures=0

cleanup() {
  local saved_status="$?"
  set +e

  if [[ -n "$test_dir" ]]; then
    pkill -f "$test_dir" 2>/dev/null || true
    rm -rf "$test_dir"
  fi

  exit "$saved_status"
}

trap cleanup EXIT

print_case_result() {
  local case_name="$1"
  local status="$2"
  local detail="$3"

  printf '%s %s %s\n' "$status" "$case_name" "$detail"
}

run_case() {
  local case_name="$1"
  shift

  if "$@"; then
    return 0
  fi

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
    "max_concurrent_per_account": 1,
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
    INSERT INTO sessions (
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

prepare_case_env() {
  local case_name="$1"
  local max_turns="$2"
  local max_cost_usd="$3"
  local idle_timeout_seconds="$4"
  local max_wall_seconds="$5"
  local cost_brake_enabled="$6"
  local case_dir="$test_dir/$case_name"

  mkdir -p "$case_dir/bin" "$case_dir/home/.hermes" "$case_dir/state"
  write_caps "$case_dir/state/hermes_caps.json" "$max_turns" "$max_cost_usd" "$idle_timeout_seconds" "$max_wall_seconds" "$cost_brake_enabled"
  initialize_state_db "$case_dir/state.db"
  printf '{"agents":[]}\n' > "$case_dir/state/active_agents.json"
  cat > "$case_dir/home/.hermes/auth.json" <<'JSON'
{
  "credential_pool": {
    "opencode-go": [
      {
        "id": "modeb-v11-test-credential",
        "label": "default"
      }
    ]
  }
}
JSON
  write_hermes_stub "$case_dir/bin/hermes"
  printf '%s\n' "$case_dir"
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

extract_marker() {
  python3 -c '
import re
import sys

match = re.search(r"\[modeb-launch-id:[^\]]+\]", sys.argv[1])
print(match.group(0) if match else "")
' "$payload"
}

write_row() {
  local session_id="$1"
  local api_call_count="$2"
  local output_tokens="$3"
  local marker="$4"

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
    (sys.argv[2], "cli", time.time(), 0.0, int(sys.argv[4]), int(sys.argv[3])),
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
    (sys.argv[2], "user", sys.argv[5], time.time()),
)
connection.commit()
' "$HERMES_STATE_DB" "$session_id" "$api_call_count" "$output_tokens" "$marker"
}

update_row() {
  local session_id="$1"
  local api_call_count="$2"
  local output_tokens="$3"

  python3 -c '
import sqlite3
import sys

connection = sqlite3.connect(sys.argv[1])
connection.execute(
    "UPDATE sessions SET api_call_count = ?, output_tokens = ? WHERE id = ?",
    (int(sys.argv[3]), int(sys.argv[4]), sys.argv[2]),
)
connection.commit()
' "$HERMES_STATE_DB" "$session_id" "$api_call_count" "$output_tokens"
}

if [[ "$payload" == *"MODEB_STUB_IGNORE_TERM"* ]]; then
  trap "" TERM
  while true; do sleep 1; done
fi

if [[ "$payload" == *"MODEB_STUB_NO_ROW_SLEEP"* ]]; then
  sleep 60
  exit 0
fi

if [[ "$payload" == *"MODEB_STUB_STEADY_ROWS"* ]]; then
  marker="$(extract_marker)"
  write_row "steady-row" 1 10 "$marker"
  sleep 1
  update_row "steady-row" 2 20
  sleep 1
  update_row "steady-row" 3 30
  printf 'MODEB_STUB_STEADY_DONE\n'
  exit 0
fi

if [[ "$payload" == *"MODEB_STUB_TURN_FALLBACK"* ]]; then
  printf 'maximum turn cap reached before final synthesis\n'
  exit 0
fi

printf 'MODEB_STUB_OK\n'
EOF

  chmod +x "$stub_path"
}

run_modeb() {
  local case_dir="$1"
  local output_path="$2"
  local max_turns="$3"
  local max_cost_usd="$4"
  local idle_timeout_seconds="$5"
  local max_wall_seconds="$6"
  local task="$7"

  HOME="$case_dir/home" \
  NEXUS_STATE_DIR="$case_dir/state" \
  HERMES_CAPS_PATH="$case_dir/state/hermes_caps.json" \
  HERMES_STATE_DB="$case_dir/state.db" \
  HERMES_MODEB_KILL_GRACE_SECONDS=1 \
  PATH="$case_dir/bin:$PATH" \
    bash "$MODEB_PATH" \
      --model opencode-go/glm-5.1 \
      --account default \
      --session "modeb-v11-$(basename "$case_dir")" \
      --max-turns "$max_turns" \
      --max-cost-usd "$max_cost_usd" \
      --idle-timeout "$idle_timeout_seconds" \
      --max-wall-seconds "$max_wall_seconds" \
      "$task" \
      > "$output_path" 2>&1
}

wait_for_pid_dead() {
  local pid="$1"
  local timeout_seconds="$2"
  local start_epoch
  local current_epoch
  local process_state

  start_epoch="$(date +%s)"
  while true; do
    process_state="$(ps -o stat= -p "$pid" 2>/dev/null | tr -d '[:space:]')" || return 0
    if [[ -z "$process_state" || "$process_state" == Z* ]]; then
      return 0
    fi

    current_epoch="$(date +%s)"
    if (( current_epoch - start_epoch >= timeout_seconds )); then
      return 1
    fi
    sleep 1
  done

  return 0
}

task_with_report() {
  local report_path="$1"
  local marker="$2"

  printf 'RESEARCH TASK: modeb v1.1 %s\nREPORT DESTINATION: %s\n%s\n' "$marker" "$report_path" "$marker"
}

case_f1_timeout_backstop_and_partial_report() {
  local case_dir
  local output_path
  local report_path
  local start_epoch
  local elapsed
  local exit_code=0

  case_dir="$(prepare_case_env f1-backstop 10 10 30 4 true)"
  output_path="$case_dir/output.txt"
  report_path="$case_dir/report.md"
  start_epoch="$(date +%s)"

  set +e
  run_modeb "$case_dir" "$output_path" 10 1 30 4 "$(task_with_report "$report_path" MODEB_STUB_IGNORE_TERM)"
  exit_code="$?"
  set -e
  elapsed=$(( $(date +%s) - start_epoch ))

  if [[ "$exit_code" -eq 0 ]]; then
    print_case_result "F1-backstop" "FAIL" "modeb exited 0"
    return 1
  fi
  if (( elapsed > 12 )); then
    print_case_result "F1-backstop" "FAIL" "elapsed=${elapsed}s"
    return 1
  fi
  if ! grep -q '^status=wall-clock-exceeded$' "$output_path"; then
    print_case_result "F1-backstop" "FAIL" "missing wall-clock status"
    return 1
  fi
  if ! grep -q 'Reason: wall-clock-exceeded' "$report_path"; then
    print_case_result "F1-backstop" "FAIL" "partial report missing"
    return 1
  fi

  print_case_result "F1-backstop" "PASS" "exit=$exit_code elapsed=${elapsed}s status=wall-clock-exceeded report=$(wc -c < "$report_path")B"
}

case_f1_process_group_kill() {
  local case_dir="$test_dir/f1-pgid"
  local db_path="$case_dir/state.db"
  local preexisting_ids_path="$case_dir/preexisting_ids"
  local reason_path="$case_dir/reason"
  local reason_lock_path="$case_dir/reason.lock"
  local launch_epoch
  local launch_marker="[modeb-launch-id:f1-pgid]"
  local target_pid
  local grandchild_pid

  mkdir -p "$case_dir/state"
  initialize_state_db "$db_path"
  : > "$preexisting_ids_path"
  launch_epoch="$(date +%s)"
  insert_session_row "$db_path" "pgid-row" "$launch_epoch" 5 10 "$launch_marker"

  setsid bash -c 'trap "" TERM; (trap "" TERM; while true; do sleep 1; done) & echo "$!" > "$1"; while true; do sleep 1; done' modeb-pgid "$case_dir/grandchild.pid" &
  target_pid="$!"

  for _ in {1..20}; do
    [[ -s "$case_dir/grandchild.pid" ]] && break
    sleep 0.1
  done
  grandchild_pid="$(< "$case_dir/grandchild.pid")"

  HOME="$case_dir/home" \
  NEXUS_STATE_DIR="$case_dir/state" \
  HERMES_STATE_DB="$db_path" \
  REGISTRY_PATH="/bin/true" \
  bash -c '
    source "$1"
    reason_path="$2"
    reason_lock_path="$3"
    log_path="$4"
    activity_monitor_loop "$5" "job-f1-pgid" 30 60 3 "$6" "$7" "$8"
  ' bash "$MODEB_PATH" "$reason_path" "$reason_lock_path" "$case_dir/log" "$target_pid" "$launch_epoch" "$preexisting_ids_path" "$launch_marker"

  wait_for_pid_dead "$target_pid" 8 || {
    print_case_result "F1-pgid" "FAIL" "target still alive"
    return 1
  }
  wait "$target_pid" 2>/dev/null || true
  wait_for_pid_dead "$grandchild_pid" 8 || {
    print_case_result "F1-pgid" "FAIL" "grandchild still alive"
    return 1
  }
  grep -q '^turn-cap-exceeded$' "$reason_path" || {
    print_case_result "F1-pgid" "FAIL" "reason missing"
    return 1
  }

  print_case_result "F1-pgid" "PASS" "target=$target_pid grandchild=$grandchild_pid reason=turn-cap-exceeded"
}

case_f2_idle_empty_row() {
  local case_dir
  local output_path
  local report_path
  local exit_code=0

  case_dir="$(prepare_case_env f2-idle 10 10 5 30 true)"
  output_path="$case_dir/output.txt"
  report_path="$case_dir/report.md"

  set +e
  run_modeb "$case_dir" "$output_path" 10 1 5 30 "$(task_with_report "$report_path" MODEB_STUB_NO_ROW_SLEEP)"
  exit_code="$?"
  set -e

  if [[ "$exit_code" -eq 0 ]]; then
    print_case_result "F2-idle-empty" "FAIL" "modeb exited 0"
    return 1
  fi
  grep -q '^status=idle-killed$' "$output_path" || {
    print_case_result "F2-idle-empty" "FAIL" "$(grep '^status=' "$output_path" 2>/dev/null || tail -n 1 "$output_path")"
    return 1
  }
  grep -q 'Reason: idle-killed' "$report_path" || {
    print_case_result "F2-idle-empty" "FAIL" "partial report missing"
    return 1
  }

  print_case_result "F2-idle-empty" "PASS" "exit=$exit_code status=idle-killed"
}

case_f2_steady_rows_control() {
  local case_dir
  local output_path
  local report_path

  case_dir="$(prepare_case_env f2-control 10 10 5 30 true)"
  output_path="$case_dir/output.txt"
  report_path="$case_dir/report.md"

  run_modeb "$case_dir" "$output_path" 10 1 5 30 "$(task_with_report "$report_path" MODEB_STUB_STEADY_ROWS)"

  grep -q '^status=completed$' "$output_path" || {
    print_case_result "F2-control" "FAIL" "not completed"
    return 1
  }
  if [[ -e "$report_path" ]]; then
    print_case_result "F2-control" "FAIL" "unexpected partial report"
    return 1
  fi

  print_case_result "F2-control" "PASS" "status=completed"
}

case_f3_turn_cap_fallback_partial_report() {
  local case_dir
  local output_path
  local report_path
  local exit_code=0

  case_dir="$(prepare_case_env f3-turn-fallback 10 10 30 30 true)"
  output_path="$case_dir/output.txt"
  report_path="$case_dir/report.md"

  set +e
  run_modeb "$case_dir" "$output_path" 10 1 30 30 "$(task_with_report "$report_path" MODEB_STUB_TURN_FALLBACK)"
  exit_code="$?"
  set -e

  if [[ "$exit_code" -eq 0 ]]; then
    print_case_result "F3-turn-fallback" "FAIL" "modeb exited 0"
    return 1
  fi
  grep -q '^status=turn-cap-exceeded$' "$output_path" || {
    print_case_result "F3-turn-fallback" "FAIL" "missing canonical status"
    return 1
  }
  grep -q 'Reason: turn-cap-exceeded' "$report_path" || {
    print_case_result "F3-turn-fallback" "FAIL" "partial report missing"
    return 1
  }

  print_case_result "F3-turn-fallback" "PASS" "exit=$exit_code status=turn-cap-exceeded report=$(wc -c < "$report_path")B"
}

case_f4_unwritable_reason_kills_child() {
  local case_dir="$test_dir/f4-unwritable"
  local db_path="$case_dir/state.db"
  local preexisting_ids_path="$case_dir/preexisting_ids"
  local no_write_dir="$case_dir/no-write"
  local launch_epoch
  local launch_marker="[modeb-launch-id:f4-unwritable]"
  local target_pid

  mkdir -p "$case_dir/state" "$no_write_dir"
  chmod 500 "$no_write_dir"
  initialize_state_db "$db_path"
  : > "$preexisting_ids_path"
  launch_epoch="$(date +%s)"
  insert_session_row "$db_path" "f4-row" "$launch_epoch" 5 10 "$launch_marker"

  setsid bash -c 'trap "" TERM; while true; do sleep 1; done' &
  target_pid="$!"

  HOME="$case_dir/home" \
  NEXUS_STATE_DIR="$case_dir/state" \
  HERMES_STATE_DB="$db_path" \
  REGISTRY_PATH="/bin/true" \
  bash -c '
    source "$1"
    reason_path="$2/reason"
    reason_lock_path="$2/reason.lock"
    log_path="$3"
    activity_monitor_loop "$4" "job-f4" 30 60 3 "$5" "$6" "$7"
  ' bash "$MODEB_PATH" "$no_write_dir" "$case_dir/log" "$target_pid" "$launch_epoch" "$preexisting_ids_path" "$launch_marker"
  chmod 700 "$no_write_dir"

  wait_for_pid_dead "$target_pid" 8 || {
    print_case_result "F4-unwritable-reason" "FAIL" "child still alive"
    return 1
  }
  wait "$target_pid" 2>/dev/null || true

  print_case_result "F4-unwritable-reason" "PASS" "target=$target_pid killed despite unwritable reason path"
}

case_f5_cost_brake_toggle() {
  local allow_dir
  local allow_output
  local refuse_dir
  local refuse_output
  local refuse_report
  local refuse_exit=0

  allow_dir="$(prepare_case_env f5-allow 10 1 30 30 false)"
  allow_output="$allow_dir/output.txt"
  run_modeb "$allow_dir" "$allow_output" 10 5 30 30 "$(task_with_report "$allow_dir/report.md" MODEB_STUB_SHORT_OK)"
  grep -q '^status=completed$' "$allow_output" || {
    print_case_result "F5-toggle" "FAIL" "disabled cost brake refused"
    return 1
  }

  refuse_dir="$(prepare_case_env f5-refuse 10 1 30 30 true)"
  refuse_output="$refuse_dir/output.txt"
  refuse_report="$refuse_dir/report.md"
  set +e
  run_modeb "$refuse_dir" "$refuse_output" 10 5 30 30 "$(task_with_report "$refuse_report" MODEB_STUB_SHORT_OK)"
  refuse_exit="$?"
  set -e

  if [[ "$refuse_exit" -ne 2 ]]; then
    print_case_result "F5-toggle" "FAIL" "enabled brake exit=$refuse_exit"
    return 1
  fi
  grep -q 'preflight refused modeb launch' "$refuse_output" || {
    print_case_result "F5-toggle" "FAIL" "refusal output missing"
    return 1
  }
  grep -q 'Reason: preflight-cost-brake-refused' "$refuse_report" || {
    print_case_result "F5-toggle" "FAIL" "refusal artifact missing"
    return 1
  }

  print_case_result "F5-toggle" "PASS" "disabled=completed enabled_exit=$refuse_exit artifact=$(wc -c < "$refuse_report")B"
}

main() {
  test_dir="$(mktemp -d "$TMP_ROOT/modeb-v11-test.XXXXXX")"

  run_case "F1-backstop" case_f1_timeout_backstop_and_partial_report
  run_case "F1-pgid" case_f1_process_group_kill
  run_case "F2-idle-empty" case_f2_idle_empty_row
  run_case "F2-control" case_f2_steady_rows_control
  run_case "F3-turn-fallback" case_f3_turn_cap_fallback_partial_report
  run_case "F4-unwritable-reason" case_f4_unwritable_reason_kills_child
  run_case "F5-toggle" case_f5_cost_brake_toggle

  if [[ "$case_failures" -gt 0 ]]; then
    printf 'FAILURES %s\n' "$case_failures"
    return 1
  fi

  printf 'ALL PASS\n'
}

main "$@"

#!/bin/bash
set -euo pipefail

declare -r SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
declare -r MODEB_PATH="${SCRIPT_DIR}/modeb.sh"
declare -r REGISTRY_PATH="/home/brodey/nexus/scripts/hermes_agent_registry.py"
declare -r ACTIVE_AGENTS_PATH="/home/brodey/.nexus/state/active_agents.json"
declare -r TMP_ROOT="${TMPDIR:-/tmp}"

test_dir=""
active_wrapper_pids=()
case_failures=0
case_skipped=0
before_temp_list=""
started_wrapper_pid=""

cleanup() {
  local saved_status="$?"
  set +e

  for wrapper_pid in "${active_wrapper_pids[@]:-}"; do
    if [[ -n "$wrapper_pid" ]] && kill -0 "$wrapper_pid" 2>/dev/null; then
      kill "$wrapper_pid" 2>/dev/null
      wait "$wrapper_pid" 2>/dev/null
    fi
  done

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

  case_skipped=0
  if "$@"; then
    if [[ "$case_skipped" -eq 1 ]]; then
      return 0
    fi
    print_case_result "$case_name" "PASS"
    return 0
  fi

  print_case_result "$case_name" "FAIL"
  case_failures=$((case_failures + 1))
  return 0
}

modeb_args() {
  if [[ -n "${HERMES_MODEB_MODEL:-}" ]]; then
    printf '%s\n' "--model"
    printf '%s\n' "$HERMES_MODEB_MODEL"
  fi
}

run_longrun_background() {
  local account="$1"
  local session_name="$2"
  local output_path="$3"
  local task="$4"
  shift 4
  local model_args=()

  mapfile -t model_args < <(modeb_args)

  bash "$MODEB_PATH" \
    "${model_args[@]}" \
    --account "$account" \
    --session "$session_name" \
    "$@" \
    "$task" \
    > "$output_path" 2>&1 &

  started_wrapper_pid="$!"
  active_wrapper_pids+=("$started_wrapper_pid")
}

read_account_entries() {
  local account="$1"

  python3 -c '
import json
import sys

state_path = sys.argv[1]
account = sys.argv[2]

try:
    with open(state_path, "r", encoding="utf-8") as handle:
        payload = json.load(handle)
except FileNotFoundError:
    payload = {}

if isinstance(payload, dict):
    if all(isinstance(entry, dict) for entry in payload.values()):
        entries = list(payload.values())
    else:
        entries = payload.get("agents", payload.get("active_agents", []))
elif isinstance(payload, list):
    entries = payload
else:
    entries = []

matched_entries = [
    entry for entry in entries
    if isinstance(entry, dict) and entry.get("account") == account
]
print(json.dumps(matched_entries))
' "$ACTIVE_AGENTS_PATH" "$account"
}

entry_count_for_account() {
  local account="$1"

  read_account_entries "$account" | python3 -c 'import json, sys; print(len(json.load(sys.stdin)))'
}

first_last_activity_for_account() {
  local account="$1"

  read_account_entries "$account" | python3 -c '
import json
import sys

entries = json.load(sys.stdin)
print(entries[0].get("last_activity", "") if entries else "")
'
}

wait_for_account_entry() {
  local account="$1"
  local timeout_seconds="$2"
  local start_epoch
  local current_epoch

  start_epoch="$(date +%s)"
  while true; do
    if [[ "$(entry_count_for_account "$account")" -gt 0 ]]; then
      return 0
    fi

    current_epoch="$(date +%s)"
    if (( current_epoch - start_epoch >= timeout_seconds )); then
      return 1
    fi

    sleep 1
  done
}

wait_for_no_account_entry() {
  local account="$1"
  local timeout_seconds="$2"
  local start_epoch
  local current_epoch

  start_epoch="$(date +%s)"
  while true; do
    if [[ "$(entry_count_for_account "$account")" -eq 0 ]]; then
      return 0
    fi

    current_epoch="$(date +%s)"
    if (( current_epoch - start_epoch >= timeout_seconds )); then
      return 1
    fi

    sleep 1
  done
}

wait_for_last_activity_advance() {
  local account="$1"
  local original_activity="$2"
  local timeout_seconds="$3"
  local start_epoch
  local current_epoch
  local current_activity

  start_epoch="$(date +%s)"
  while true; do
    current_activity="$(first_last_activity_for_account "$account")"
    if [[ -n "$current_activity" && "$current_activity" != "$original_activity" ]]; then
      return 0
    fi

    current_epoch="$(date +%s)"
    if (( current_epoch - start_epoch >= timeout_seconds )); then
      return 1
    fi

    sleep 2
  done
}

remove_active_wrapper_pid() {
  local finished_pid="$1"
  local remaining_pids=()
  local wrapper_pid

  for wrapper_pid in "${active_wrapper_pids[@]:-}"; do
    if [[ "$wrapper_pid" != "$finished_pid" ]]; then
      remaining_pids+=("$wrapper_pid")
    fi
  done

  active_wrapper_pids=("${remaining_pids[@]:-}")
}

write_modeb_registry_stub() {
  local stub_path="$1"

  cat > "$stub_path" <<'EOF'
#!/usr/bin/env python3
import json
import os
import sys

command = sys.argv[1]
touch_log_path = os.environ["MODEB_TEST_TOUCH_LOG"]

if command == "touch":
    with open(touch_log_path, "a", encoding="utf-8") as handle:
        handle.write(sys.argv[3] + "\n")
    sys.exit(0)

if command == "release":
    sys.exit(0)

raise SystemExit(1)
EOF

  chmod +x "$stub_path"
}

initialize_modeb_state_db() {
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
        user_id TEXT,
        model TEXT,
        model_config TEXT,
        system_prompt TEXT,
        parent_session_id TEXT,
        started_at REAL NOT NULL,
        ended_at REAL,
        end_reason TEXT,
        message_count INTEGER DEFAULT 0,
        tool_call_count INTEGER DEFAULT 0,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cache_read_tokens INTEGER DEFAULT 0,
        cache_write_tokens INTEGER DEFAULT 0,
        reasoning_tokens INTEGER DEFAULT 0,
        billing_provider TEXT,
        billing_base_url TEXT,
        billing_mode TEXT,
        estimated_cost_usd REAL,
        actual_cost_usd REAL,
        cost_status TEXT,
        cost_source TEXT,
        pricing_version TEXT,
        title TEXT,
        api_call_count INTEGER DEFAULT 0,
        handoff_state TEXT,
        handoff_platform TEXT,
        handoff_error TEXT
    );
    CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        tool_call_id TEXT,
        tool_calls TEXT,
        tool_name TEXT,
        timestamp REAL NOT NULL,
        token_count INTEGER,
        finish_reason TEXT,
        reasoning TEXT,
        reasoning_content TEXT,
        reasoning_details TEXT,
        codex_reasoning_items TEXT,
        codex_message_items TEXT,
        platform_message_id TEXT,
        observed INTEGER DEFAULT 0
    );
    """
)
connection.commit()
' "$db_path"
}

insert_modeb_session() {
  local db_path="$1"
  local session_id="$2"
  local started_at="$3"
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
        message_count,
        output_tokens,
        estimated_cost_usd,
        api_call_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    """,
    (sys.argv[2], "cli", float(sys.argv[3]), 1, int(sys.argv[5]), 0.0, int(sys.argv[4])),
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
' "$db_path" "$session_id" "$started_at" "$api_call_count" "$output_tokens" "$message_content"
}

update_modeb_session_metrics() {
  local db_path="$1"
  local session_id="$2"
  local api_call_count="$3"
  local output_tokens="$4"

  python3 -c '
import sqlite3
import sys

connection = sqlite3.connect(sys.argv[1])
connection.execute(
    """
    UPDATE sessions
    SET api_call_count = ?, output_tokens = ?
    WHERE id = ?
    """,
    (int(sys.argv[3]), int(sys.argv[4]), sys.argv[2]),
)
connection.commit()
' "$db_path" "$session_id" "$api_call_count" "$output_tokens"
}

case_session_binding_revalidates_target() {
  local harness_dir="$test_dir/session-binding"
  local db_path="$harness_dir/state.db"
  local preexisting_ids_path="$harness_dir/preexisting_ids"
  local touch_log_path="$harness_dir/touch.log"
  local stub_registry_path="$harness_dir/registry_stub.py"
  local harness_log_path="$harness_dir/hermes.log"
  local harness_reason_path="$harness_dir/stop.reason"
  local harness_reason_lock_path="$harness_dir/stop.reason.lock"
  local launch_epoch
  local launch_marker="[modeb-launch-id:test-binding-marker]"
  local monitor_pid
  local monitor_exit=0
  local target_pid
  local touch_count

  mkdir -p "$harness_dir"
  : > "$preexisting_ids_path"
  : > "$touch_log_path"
  : > "$harness_log_path"
  write_modeb_registry_stub "$stub_registry_path"
  initialize_modeb_state_db "$db_path"

  launch_epoch="$(date +%s)"
  insert_modeb_session "$db_path" "target-row" "$launch_epoch" 1 10 "$launch_marker target"

  (
    sleep 30
  ) &
  target_pid="$!"

  env \
    MODEB_TEST_TOUCH_LOG="$touch_log_path" \
    REGISTRY_PATH="$stub_registry_path" \
    HERMES_STATE_DB="$db_path" \
    MODEB_PATH="$MODEB_PATH" \
    HARNESS_REASON_PATH="$harness_reason_path" \
    HARNESS_REASON_LOCK_PATH="$harness_reason_lock_path" \
    HARNESS_LOG_PATH="$harness_log_path" \
    TARGET_PID="$target_pid" \
    LAUNCH_EPOCH="$launch_epoch" \
    PREEXISTING_IDS_PATH="$preexisting_ids_path" \
    LAUNCH_MARKER="$launch_marker" \
    bash -lc '
      source "$MODEB_PATH"
      reason_path="$HARNESS_REASON_PATH"
      reason_lock_path="$HARNESS_REASON_LOCK_PATH"
      log_path="$HARNESS_LOG_PATH"
      activity_monitor_loop "$TARGET_PID" "job-binding" 6 20 99 "$LAUNCH_EPOCH" "$PREEXISTING_IDS_PATH" "$LAUNCH_MARKER"
    ' &
  monitor_pid="$!"

  sleep 4
  update_modeb_session_metrics "$db_path" "target-row" 2 20

  sleep 1
  insert_modeb_session "$db_path" "decoy-row" "$((launch_epoch + 1))" 1 5 "decoy session"
  update_modeb_session_metrics "$db_path" "decoy-row" 2 15
  sleep 3
  update_modeb_session_metrics "$db_path" "decoy-row" 3 25

  set +e
  wait "$monitor_pid"
  monitor_exit="$?"
  set -e

  touch_count="$(wc -l < "$touch_log_path")"

  if kill -0 "$target_pid" 2>/dev/null; then
    kill "$target_pid" 2>/dev/null || true
    wait "$target_pid" 2>/dev/null || true
  fi

  [[ "$monitor_exit" -eq 0 ]] || return 1
  [[ -f "$harness_reason_path" ]] || return 1
  grep -q '^idle-killed$' "$harness_reason_path" || return 1
  [[ "$touch_count" -eq 2 ]] || return 1
  ! kill -0 "$target_pid" 2>/dev/null
}

case_gate_acquire_before_output() {
  local account="modeb-test-gate-$$"
  local session_name="modeb-test-gate-$(date -u +%s)"
  local output_path="$test_dir/gate.out"
  local wrapper_pid

  run_longrun_background "$account" "$session_name" "$output_path" \
    "Run bash -lc 'echo MODEB_GATE_START; sleep 8; echo MODEB_GATE_DONE', then report done." \
    --max-turns 6 --idle-timeout 60 --max-cost-usd 5
  wrapper_pid="$started_wrapper_pid"

  wait_for_account_entry "$account" 30 || return 1

  if [[ -s "$output_path" ]]; then
    kill "$wrapper_pid" 2>/dev/null || true
    wait "$wrapper_pid" 2>/dev/null || true
    remove_active_wrapper_pid "$wrapper_pid"
    return 1
  fi

  wait "$wrapper_pid"
  remove_active_wrapper_pid "$wrapper_pid"
  wait_for_no_account_entry "$account" 20
}

case_activity_touch_advances() {
  local account="modeb-test-touch-$$"
  local session_name="modeb-test-touch-$(date -u +%s)"
  local output_path="$test_dir/touch.out"
  local wrapper_pid
  local original_activity

  run_longrun_background "$account" "$session_name" "$output_path" \
    "Count from 1 to 10. After each number, pause briefly (1 second max) before the next. Output format: say the number, then say what comes next. Then finish and report MODEB_TOUCH_DONE." \
    --max-turns 8 --idle-timeout 90 --max-cost-usd 5
  wrapper_pid="$started_wrapper_pid"

  wait_for_account_entry "$account" 30 || return 1
  original_activity="$(first_last_activity_for_account "$account")"
  [[ -n "$original_activity" ]] || return 1

  wait_for_last_activity_advance "$account" "$original_activity" 45 || return 1

  wait "$wrapper_pid"
  remove_active_wrapper_pid "$wrapper_pid"
  wait_for_no_account_entry "$account" 20
}

case_clean_release() {
  local account="modeb-test-release-$$"
  local session_name="modeb-test-release-$(date -u +%s)"
  local output_path="$test_dir/release.out"
  local wrapper_pid

  run_longrun_background "$account" "$session_name" "$output_path" \
    "Say MODEB_RELEASE_DONE and stop." \
    --max-turns 4 --idle-timeout 60 --max-cost-usd 5
  wrapper_pid="$started_wrapper_pid"

  wait_for_account_entry "$account" 30 || return 1
  wait "$wrapper_pid"
  remove_active_wrapper_pid "$wrapper_pid"
  wait_for_no_account_entry "$account" 20 || return 1
  grep -q '^status=completed$' "$output_path"
}

case_concurrency_refused() {
  local account="modeb-test-concurrency-$$"
  local first_session="modeb-test-concurrency-a-$(date -u +%s)"
  local second_session="modeb-test-concurrency-b-$(date -u +%s)"
  local first_output="$test_dir/concurrency-first.out"
  local second_output="$test_dir/concurrency-second.out"
  local wrapper_pid
  local second_exit=0
  local model_args=()

  mapfile -t model_args < <(modeb_args)

  run_longrun_background "$account" "$first_session" "$first_output" \
    "Run bash -lc 'echo MODEB_CONCURRENCY_START; sleep 20; echo MODEB_CONCURRENCY_DONE', then report done." \
    --max-turns 8 --idle-timeout 90 --max-cost-usd 5
  wrapper_pid="$started_wrapper_pid"

  wait_for_account_entry "$account" 30 || return 1

  set +e
  bash "$MODEB_PATH" \
    "${model_args[@]}" \
    --account "$account" \
    --session "$second_session" \
    --max-turns 4 \
    --idle-timeout 60 \
    --max-cost-usd 5 \
    "Say MODEB_SECOND_SHOULD_REFUSE." \
    > "$second_output" 2>&1
  second_exit="$?"
  set -e

  [[ "$second_exit" -eq 3 ]] || return 1
  [[ "$(entry_count_for_account "$account")" -eq 1 ]] || return 1

  wait "$wrapper_pid"
  remove_active_wrapper_pid "$wrapper_pid"
  wait_for_no_account_entry "$account" 20
}

case_memory_recall_full() {
  local account="modeb-test-memory-$$"
  local session_name="modeb-test-memory-$(date -u +%s)"
  local fact_tag="MODEB_MEMORY_FACT_$(date -u +%s)_$$"
  local output_path="$test_dir/memory.out"
  local recall_output="$test_dir/memory-recall.out"
  local wrapper_pid

  run_longrun_background "$account" "$session_name" "$output_path" \
    "Remember this exact tagged fact for later recall: $fact_tag means blue-ridge-17. Reply done." \
    --max-turns 6 --idle-timeout 90 --max-cost-usd 5
  wrapper_pid="$started_wrapper_pid"

  wait "$wrapper_pid"
  remove_active_wrapper_pid "$wrapper_pid"
  wait_for_no_account_entry "$account" 20 || return 1

  hermes -z "What value was stored for $fact_tag? Reply with only the value." --yolo > "$recall_output" 2>&1
  grep -q 'blue-ridge-17' "$recall_output"
}

case_vault_write_full() {
  local account="modeb-test-vault-$$"
  local session_name="modeb-test-vault-$(date -u +%s)"
  local note_name="modeb-test-$(date -u +%s)-$$.md"
  local vault_path="03_Inbox/_raw/$note_name"
  local output_path="$test_dir/vault.out"
  local get_output="$test_dir/vault-get.out"
  local wrapper_pid
  local encoded_path
  local obsidian_key_assignment

  if [[ -f /home/brodey/vault/.env ]]; then
    obsidian_key_assignment="$(grep '^OBSIDIAN_API_KEY=' /home/brodey/vault/.env | tail -n 1 || true)"
    if [[ -n "$obsidian_key_assignment" ]]; then
      export "$obsidian_key_assignment"
    fi
  fi

  if [[ -z "${OBSIDIAN_API_KEY:-}" ]] && [[ -f /home/brodey/secure/credentials/nexus.env ]]; then
    obsidian_key_assignment="$(grep '^OBSIDIAN_API_KEY=' /home/brodey/secure/credentials/nexus.env | tail -n 1 || true)"
    if [[ -n "$obsidian_key_assignment" ]]; then
      export "$obsidian_key_assignment"
    fi
  fi

  if [[ -z "${OBSIDIAN_API_KEY:-}" ]] || ! curl -sk --max-time 3 https://localhost:27124/ -o /dev/null; then
    print_case_result "case-6-vault-write" "SKIP"
    case_skipped=1
    return 0
  fi

  run_longrun_background "$account" "$session_name" "$output_path" \
    "Using the Obsidian REST API, write a note at $vault_path containing MODEB_VAULT_WRITE_OK. Do not write to vault root." \
    --max-turns 10 --idle-timeout 120 --max-cost-usd 5
  wrapper_pid="$started_wrapper_pid"

  wait "$wrapper_pid"
  remove_active_wrapper_pid "$wrapper_pid"
  wait_for_no_account_entry "$account" 20 || return 1

  encoded_path="$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$vault_path")"
  curl -sk \
    -H "Authorization: Bearer $OBSIDIAN_API_KEY" \
    "https://localhost:27124/vault/$encoded_path" \
    > "$get_output"

  grep -q 'MODEB_VAULT_WRITE_OK' "$get_output"
}

case_idle_stop_full() {
  local account="modeb-test-idle-$$"
  local session_name="modeb-test-idle-$(date -u +%s)"
  local output_path="$test_dir/idle.out"
  local idle_exit=0
  local model_args=()

  mapfile -t model_args < <(modeb_args)

  set +e
  bash "$MODEB_PATH" \
    "${model_args[@]}" \
    --account "$account" \
    --session "$session_name" \
    --max-turns 8 \
    --idle-timeout 5 \
    --max-cost-usd 5 \
    "Run bash -lc 'sleep 20; echo MODEB_IDLE_DONE', then report done." \
    > "$output_path" 2>&1
  idle_exit="$?"
  set -e

  [[ "$idle_exit" -ne 0 ]] || return 1
  grep -q '^status=idle-killed$' "$output_path" || return 1
  wait_for_no_account_entry "$account" 20
}

case_no_leaks() {
  local after_temp_list="$test_dir/after-temp.txt"
  local new_temp_list="$test_dir/new-temp.txt"

  python3 "$REGISTRY_PATH" list >/dev/null || return 1

  if ! wait_for_no_account_entry "modeb-test-gate-$$" 1; then return 1; fi
  if ! wait_for_no_account_entry "modeb-test-touch-$$" 1; then return 1; fi
  if ! wait_for_no_account_entry "modeb-test-release-$$" 1; then return 1; fi
  if ! wait_for_no_account_entry "modeb-test-concurrency-$$" 1; then return 1; fi
  if ! wait_for_no_account_entry "modeb-test-memory-$$" 1; then return 1; fi
  if ! wait_for_no_account_entry "modeb-test-vault-$$" 1; then return 1; fi
  if ! wait_for_no_account_entry "modeb-test-idle-$$" 1; then return 1; fi

  find "$TMP_ROOT" -maxdepth 1 -name 'hermes-modeb.*' -print | sort > "$after_temp_list"
  comm -13 "$before_temp_list" "$after_temp_list" > "$new_temp_list"
  [[ ! -s "$new_temp_list" ]]
}

main() {
  test_dir="$(mktemp -d "$TMP_ROOT/modeb-test.XXXXXX")"
  before_temp_list="$test_dir/before-temp.txt"
  find "$TMP_ROOT" -maxdepth 1 -name 'hermes-modeb.*' -print | sort > "$before_temp_list"

  run_case "case-1-gate-acquire-before-output" case_gate_acquire_before_output
  run_case "case-2-last-activity-advances" case_activity_touch_advances
  run_case "case-3-clean-release" case_clean_release
  run_case "case-4-concurrency-refused" case_concurrency_refused
  run_case "case-5-session-binding" case_session_binding_revalidates_target

  if [[ "${HERMES_MODEB_FULL:-0}" == "1" ]]; then
    run_case "case-6-memory-recall" case_memory_recall_full
    run_case "case-7-vault-write" case_vault_write_full
    run_case "case-8-idle-stop" case_idle_stop_full
  else
    print_case_result "case-6-memory-recall" "SKIP"
    print_case_result "case-7-vault-write" "SKIP"
    print_case_result "case-8-idle-stop" "SKIP"
  fi

  run_case "case-9-no-leaks" case_no_leaks

  if [[ "$case_failures" -gt 0 ]]; then
    return 1
  fi

  return 0
}

main "$@"

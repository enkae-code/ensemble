#!/bin/bash
set -euo pipefail

declare -r SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
declare -r CAPS_PATH="${HERMES_CAPS_PATH:-${SCRIPT_DIR}/hermes-caps.default.json}"
declare -r HERMES_BIN="${HERMES_BIN:-hermes}"
declare -r HERMES_STATE_DB="${HERMES_STATE_DB:-$HOME/.hermes/state.db}"
declare -r HERMES_WORKDIR="${HERMES_WORKDIR:-${VAULT_ROOT:-$PWD}}"
declare -r DEFAULT_PROVIDER="opencode-go"
declare -r DEFAULT_MODEL="glm-5.1"
declare -r MODEB_LAUNCH_MARKER_PREFIX="[modeb-launch-id:"
declare -r PARTIAL_REPORT_REASONS_REGEX='^(turn-cap-exceeded|wall-clock-exceeded|idle-killed|preflight-cost-brake-refused)$'
declare -r MODEB_KILL_GRACE_SECONDS="${HERMES_MODEB_KILL_GRACE_SECONDS:-3}"
declare -r MODEB_FIFO_HANDSHAKE_TIMEOUT_SECONDS="${HERMES_MODEB_FIFO_HANDSHAKE_TIMEOUT_SECONDS:-}"

work_dir=""
fifo_path=""
preexisting_ids_path=""
log_path=""
preflight_stdout_path=""
preflight_stderr_path=""
preflight_caps_path=""
prelaunch_payload_path=""
session_child_pid_path=""
reason_path=""
reason_lock_path=""
launcher_pid=""
child_pid=""
monitor_pid=""
job_id=""
child_waited=0
modeb_metadata_path="${MODEB_METADATA_PATH:-}"
modeb_final_status="unknown"

durable_log_path() {
  local id="${job_id:-modeb-$(date +%Y%m%d-%H%M%S)}"
  printf '%s/.hermes/results/%s-hermes.log' "$HOME" "$id"
}

prelaunch_hook_available() {
  [[ -n "${HERMES_HOOK_PRELAUNCH:-}" && -x "$HERMES_HOOK_PRELAUNCH" ]]
}

prelaunch_hook_misconfigured() {
  [[ -n "${HERMES_HOOK_PRELAUNCH:-}" && ! -x "$HERMES_HOOK_PRELAUNCH" ]]
}

hook_available() {
  local hook_var="$1"
  local hook_path="${!hook_var:-}"

  [[ -n "$hook_path" && -x "$hook_path" ]]
}

usage() {
  cat << 'EOF'
modeb.sh [--model <provider>/<model>] [--account <account>] [--session <name>] \
         [--max-turns <n>] [--max-cost-usd <amount>] [--idle-timeout <seconds>] \
         [--max-wall-seconds <seconds>] "<task>"
EOF
}

read_caps_defaults() {
  python3 -c '
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as handle:
    caps = json.load(handle)

print(caps.get("max_turns", 15))
print(caps.get("max_cost_usd", 2.5))
print(caps.get("idle_timeout_seconds", 900))
print(caps.get("max_wall_seconds", 1800))
print(caps.get("min_iteration_floor", 3))
print(caps.get("confidence_threshold", 80))
print(caps.get("saturation_threshold", 2))
print("true" if caps.get("cost_brake_enabled", True) else "false")
' "$CAPS_PATH"
}

is_positive_integer() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

is_positive_number() {
  python3 -c '
import sys

try:
    value = float(sys.argv[1])
except ValueError:
    sys.exit(1)

sys.exit(0 if value > 0 else 1)
' "$1"
}

split_model_route() {
  local route="$1"
  local -n provider_ref="$2"
  local -n model_ref="$3"

  if [[ "$route" != */* ]]; then
    echo "--model must be <provider>/<model>" >&2
    return 1
  fi

  provider_ref="${route%%/*}"
  model_ref="${route#*/}"

  if [[ -z "$provider_ref" || -z "$model_ref" ]]; then
    echo "--model must be <provider>/<model>" >&2
    return 1
  fi
}

reject_retired_provider() {
  local provider="$1"

  if [[ "$provider" == "copilot" ]]; then
    echo "GitHub Copilot is retired NEXUS-wide; --model copilot/* is rejected" >&2
    return 1
  fi

  return 0
}

build_launch_marker() {
  python3 -c '
import uuid
import sys

print(f"{sys.argv[1]}{uuid.uuid4().hex}]")
' "$MODEB_LAUNCH_MARKER_PREFIX"
}

build_task_payload() {
  local launch_marker="$1"
  local task="$2"
  local max_turns="$3"
  local max_cost_usd="$4"
  local idle_timeout_seconds="$5"
  local max_wall_seconds="$6"
  local min_iteration_floor="$7"
  local confidence_threshold="$8"
  local saturation_threshold="$9"

  if [[ "$task" == *"name: deep-loop"* || "$task" == *"# Deep-Research Loop"* ]]; then
    printf '%s\n\n%s\n\n---\nRUNTIME CAPS (authoritative): turns=%s, cost=$%s, idle=%ss, wall=%ss\nSTOP-LOGIC SETTINGS (authoritative): min_iteration_floor=%s, confidence_threshold=%s, saturation_threshold=%s\nRead these exact values. Do not invent replacements.\n' \
      "$launch_marker" \
      "$task" \
      "$max_turns" \
      "$max_cost_usd" \
      "$idle_timeout_seconds" \
      "$max_wall_seconds" \
      "$min_iteration_floor" \
      "$confidence_threshold" \
      "$saturation_threshold"
    return 0
  fi

  printf '%s\n\n%s\n' "$launch_marker" "$task"
}

extract_report_destination() {
  local task_payload="$1"

  python3 -c '
import os
import re
import sys

match = re.search(r"^REPORT DESTINATION:\s*(.+?)\s*$", sys.argv[1], re.MULTILINE)
if not match:
    print("")
    sys.exit(0)

print(os.path.expanduser(match.group(1).strip()))
' "$task_payload"
}

extract_research_task() {
  local task_payload="$1"

  python3 -c '
import re
import sys

match = re.search(r"^RESEARCH TASK:\s*(.+?)\s*$", sys.argv[1], re.MULTILINE)
if not match:
    print("")
    sys.exit(0)

print(match.group(1).strip())
' "$task_payload"
}

append_partial_report() {
  local report_path="$1"
  local research_task="$2"
  local stop_reason="$3"
  local iterations_observed="$4"
  local max_turns="$5"
  local max_cost_usd="$6"
  local idle_timeout_seconds="$7"
  local max_wall_seconds="$8"
  local min_iteration_floor="$9"
  local confidence_threshold="${10}"
  local saturation_threshold="${11}"
  local note="${12}"
  local timestamp
  local heading

  if [[ -z "$report_path" ]] || [[ -z "$stop_reason" ]] || [[ ! "$stop_reason" =~ $PARTIAL_REPORT_REASONS_REGEX ]]; then
    return 0
  fi

  mkdir -p "$(dirname "$report_path")"
  timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  heading="$research_task"
  if [[ -z "$heading" ]]; then
    heading="Deep research partial report"
  fi

  if [[ ! -s "$report_path" ]]; then
    cat > "$report_path" <<EOF
# $heading
_Research loop stopped: ${timestamp}_
_Iterations: $iterations_observed | Stop reason: ${stop_reason}_
_Caps: turns=$max_turns, cost=\$$max_cost_usd, idle=${idle_timeout_seconds}s, wall=${max_wall_seconds}s_
_Stop logic: floor=$min_iteration_floor, confidence=$confidence_threshold, saturation=${saturation_threshold}_

## Summary
The run stopped before a final synthesis was produced.

## Stopped
- Reason: $stop_reason
- Note: $note

## Sources
_(none captured before stop)_

## Gaps & Unresolved
- Final report was not completed.
EOF
    return 0
  fi

  if grep -q '^## Stopped' "$report_path" 2>/dev/null; then
    return 0
  fi

  cat >> "$report_path" <<EOF

## Stopped
- Reason: $stop_reason
- Iterations observed: $iterations_observed
- Note: $note
EOF
}

write_preflight_refusal_artifacts() {
  local preflight_exit="$1"
  local task_payload="$2"
  local max_turns="$3"
  local max_cost_usd="$4"
  local idle_timeout_seconds="$5"
  local max_wall_seconds="$6"
  local min_iteration_floor="$7"
  local confidence_threshold="$8"
  local saturation_threshold="$9"
  local refusal_note="${10:-Preflight cost brake refused the launch before Hermes started.}"
  local report_path
  local research_task
  local durable_path

  if [[ "$preflight_exit" -ne 2 ]]; then
    return 0
  fi

  report_path="$(extract_report_destination "$task_payload")"
  research_task="$(extract_research_task "$task_payload")"
  append_partial_report \
    "$report_path" \
    "$research_task" \
    "preflight-cost-brake-refused" \
    "0" \
    "$max_turns" \
    "$max_cost_usd" \
    "$idle_timeout_seconds" \
    "$max_wall_seconds" \
    "$min_iteration_floor" \
    "$confidence_threshold" \
    "$saturation_threshold" \
    "$refusal_note"

  durable_path="$(durable_log_path)"
  mkdir -p "$HOME/.hermes/results" 2>/dev/null || true
  {
    printf 'status=preflight-cost-brake-refused\n'
    printf 'session=%s\n' "${session_name:-unknown}"
    printf 'max_turns=%s\n' "$max_turns"
    printf 'max_cost_usd=%s\n' "$max_cost_usd"
    if [[ -s "$preflight_stderr_path" ]]; then
      printf '\n[stderr]\n'
      cat "$preflight_stderr_path"
    fi
    if [[ -s "$preflight_stdout_path" ]]; then
      printf '\n[stdout]\n'
      cat "$preflight_stdout_path"
    fi
  } > "$durable_path"
  printf 'preflight-report: %s\n' "$durable_path" >&2
}

write_prelaunch_payload() {
  local destination_path="$1"
  local caps_path="$2"
  local account="$3"
  local provider="$4"
  local model="$5"
  local pid="$6"
  local max_turns="$7"
  local max_cost_usd="$8"
  local idle_timeout_seconds="$9"
  local max_wall_seconds="${10}"
  local task_payload="${11}"

  python3 -c '
import json
import sys

destination_path, caps_path = sys.argv[1:3]
with open(caps_path, "r", encoding="utf-8") as handle:
    caps = json.load(handle)

payload = {
    "account": sys.argv[3],
    "provider": sys.argv[4],
    "model": sys.argv[5],
    "pid": int(sys.argv[6]),
    "max_turns": int(sys.argv[7]),
    "max_cost_usd": float(sys.argv[8]),
    "idle_timeout_seconds": int(sys.argv[9]),
    "max_wall_seconds": int(sys.argv[10]),
    "caps": caps,
    "task": sys.argv[11],
}
with open(destination_path, "w", encoding="utf-8") as handle:
    json.dump(payload, handle, sort_keys=True)
    handle.write("\n")
' "$destination_path" "$caps_path" "$account" "$provider" "$model" "$pid" "$max_turns" "$max_cost_usd" "$idle_timeout_seconds" "$max_wall_seconds" "$task_payload"
  chmod 600 "$destination_path"
}

extract_prelaunch_job_id() {
  local stdout_path="$1"

  python3 -c '
import json
import sys

try:
    with open(sys.argv[1], "r", encoding="utf-8") as handle:
        raw = handle.read().strip()
    if not raw:
        print("")
        sys.exit(0)
    payload = json.loads(raw)
except (OSError, json.JSONDecodeError):
    print("")
    sys.exit(0)

job_id = payload.get("job_id") if isinstance(payload, dict) else ""
print(job_id if isinstance(job_id, str) else "")
' "$stdout_path"
}

generate_job_id() {
  python3 -c 'import uuid; print(f"modeb-{uuid.uuid4().hex}")'
}

write_job_hook_payload() {
  local job_hook_id="$1"
  local pid="$2"
  local session="$3"
  local status="$4"

  python3 -c '
import json
import sys

payload = {
    "job_id": sys.argv[1],
    "pid": int(sys.argv[2]) if sys.argv[2].isdigit() else None,
    "session": sys.argv[3],
    "status": sys.argv[4],
}
json.dump(payload, sys.stdout, sort_keys=True)
sys.stdout.write("\n")
' "$job_hook_id" "$pid" "$session" "$status"
}

run_job_touch_hook() {
  local job_hook_id="$1"
  local pid="$2"
  local session="$3"
  local status="$4"

  if [[ -z "$job_hook_id" ]] || ! hook_available HERMES_HOOK_JOB_TOUCH; then
    return 1
  fi

  write_job_hook_payload "$job_hook_id" "$pid" "$session" "$status" | "$HERMES_HOOK_JOB_TOUCH" >/dev/null 2>&1 || true
  return 0
}

run_job_release_hook() {
  local job_hook_id="$1"
  local status="$2"

  if [[ -z "$job_hook_id" ]] || ! hook_available HERMES_HOOK_JOB_RELEASE; then
    return 0
  fi

  write_job_hook_payload "$job_hook_id" "" "" "$status" | "$HERMES_HOOK_JOB_RELEASE" >/dev/null 2>&1 || true
  return 0
}

resolve_row_id() {
  local launch_epoch="$1"
  local preexisting_ids_path="$2"
  local launch_marker="$3"

  python3 -c '
import sqlite3
import sys

db_path = sys.argv[1]
launch_epoch = int(sys.argv[2])
preexisting_ids_path = sys.argv[3]
launch_marker = sys.argv[4]

try:
    with open(preexisting_ids_path, "r", encoding="utf-8") as handle:
        preexisting_ids = {line.strip() for line in handle if line.strip()}
except OSError:
    preexisting_ids = set()

try:
    connection = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    cursor = connection.execute(
        """
        SELECT DISTINCT sessions.id
        FROM sessions
        JOIN messages ON messages.session_id = sessions.id
        WHERE sessions.started_at >= ?
          AND messages.role = ?
          AND INSTR(COALESCE(messages.content, ""), ?) > 0
        ORDER BY sessions.started_at ASC
        """,
        (launch_epoch, "user", launch_marker),
    )
except sqlite3.Error:
    print("")
    sys.exit(0)

try:
    for session_record in cursor:
        session_id = session_record[0]
        if session_id not in preexisting_ids:
            print(session_id)
            sys.exit(0)
except sqlite3.Error:
    print("")
    sys.exit(0)

print("")
' "$HERMES_STATE_DB" "$launch_epoch" "$preexisting_ids_path" "$launch_marker"
}

query_row_metrics() {
  local row_id="$1"

  python3 -c '
import sqlite3
import sys

db_path = sys.argv[1]
row_id = sys.argv[2]

try:
    connection = sqlite3.connect(db_path)
    cursor = connection.execute(
        """
        SELECT
          COALESCE(api_call_count, 0),
          COALESCE(output_tokens, 0),
          COALESCE(actual_cost_usd, estimated_cost_usd, 0)
        FROM sessions
        WHERE id = ?
        LIMIT 1
        """,
        (row_id,),
    )
    session_record = cursor.fetchone()
except sqlite3.Error:
    print("0 0 0")
    sys.exit(0)

if not session_record:
    print("0 0 0")
    sys.exit(0)

api_call_count, output_tokens, observed_cost = session_record
print(f"{api_call_count} {output_tokens} {observed_cost}")
' "$HERMES_STATE_DB" "$row_id"
}

query_session_cost() {
  local launch_epoch="$1"
  local preexisting_ids_path="$2"
  local launch_marker="$3"
  local row_id
  local metrics
  local api_call_count
  local output_tokens
  local observed_cost

  row_id="$(resolve_row_id "$launch_epoch" "$preexisting_ids_path" "$launch_marker")"
  if [[ -z "$row_id" ]]; then
    printf '0\n'
    return 0
  fi

  metrics="$(query_row_metrics "$row_id")"
  read -r api_call_count output_tokens observed_cost <<< "$metrics"
  printf '%s\n' "${observed_cost:-0}"
}

record_final_activity() {
  local registry_job_id="$1"
  local launch_epoch="$2"
  local preexisting_ids_path="$3"
  local launch_marker="$4"
  local session_label="${5:-}"
  local row_id

  if [[ -z "$registry_job_id" ]] || ! hook_available HERMES_HOOK_JOB_TOUCH; then
    return 1
  fi

  row_id="$(resolve_row_id "$launch_epoch" "$preexisting_ids_path" "$launch_marker")"
  if [[ -z "$row_id" ]]; then
    return 1
  fi

  run_job_touch_hook "$registry_job_id" "$$" "$session_label" "finalizing" || true
  return 0
}

set_stop_reason() {
  local stop_reason="$1"

  if ( set -C; : > "$reason_lock_path" ) 2>/dev/null; then
    printf '%s\n' "$stop_reason" > "$reason_path" 2>/dev/null || true
  fi

  return 0
}

wait_for_session_leader() {
  local target_pid="$1"
  local deadline_ms
  local current_ms
  local target_pgid=""

  deadline_ms=$(( $(date +%s%3N) + 1000 ))
  while kill -0 "$target_pid" 2>/dev/null; do
    target_pgid="$(ps -o pgid= -p "$target_pid" 2>/dev/null | tr -d '[:space:]')" || target_pgid=""
    if [[ -n "$target_pgid" && "$target_pgid" == "$target_pid" ]]; then
      return 0
    fi

    current_ms="$(date +%s%3N)"
    if (( current_ms >= deadline_ms )); then
      return 0
    fi

    sleep 0.05
  done

  return 0
}

read_session_child_pid() {
  local pid_file="$1"
  local fallback_pid="$2"
  local deadline_ms
  local current_ms
  local resolved_pid=""

  deadline_ms=$(( $(date +%s%3N) + 1000 ))
  while kill -0 "$fallback_pid" 2>/dev/null; do
    if [[ -s "$pid_file" ]]; then
      resolved_pid="$(tr -d '[:space:]' < "$pid_file")"
      if [[ "$resolved_pid" =~ ^[1-9][0-9]*$ ]]; then
        printf '%s\n' "$resolved_pid"
        return 0
      fi
    fi

    current_ms="$(date +%s%3N)"
    if (( current_ms >= deadline_ms )); then
      break
    fi

    sleep 0.05
  done

  printf '%s\n' "$fallback_pid"
}

terminate_child() {
  local target_pid="$1"
  local target_pgid=""
  local current_pgid=""
  local killed_by_group=0

  if [[ -z "$target_pid" ]] || ! kill -0 "$target_pid" 2>/dev/null; then
    return 0
  fi

  current_pgid="$(ps -o pgid= -p "$$" 2>/dev/null | tr -d '[:space:]')" || current_pgid=""
  wait_for_session_leader "$target_pid"
  target_pgid="$(ps -o pgid= -p "$target_pid" 2>/dev/null | tr -d '[:space:]')" || target_pgid=""

  if [[ -n "$target_pgid" && "$target_pgid" != "$current_pgid" && "$target_pgid" != "1" ]]; then
    killed_by_group=1
    kill -TERM -- "-$target_pgid" 2>/dev/null || true
  else
    kill -TERM "$target_pid" 2>/dev/null || true
  fi
  sleep 3

  if (( killed_by_group == 1 )); then
    if kill -0 -- "-$target_pgid" 2>/dev/null; then
      kill -KILL -- "-$target_pgid" 2>/dev/null || true
    fi
    return 0
  fi

  if kill -0 "$target_pid" 2>/dev/null; then
    kill -KILL "$target_pid" 2>/dev/null || true
  fi
}

write_preflight_caps() {
  local destination_path="$1"
  local cost_brake_enabled="$2"

  python3 -c '
import json
import sys

source_path, destination_path, raw_enabled = sys.argv[1:4]
with open(source_path, "r", encoding="utf-8") as handle:
    caps = json.load(handle)

caps["cost_brake_enabled"] = raw_enabled == "true"

with open(destination_path, "w", encoding="utf-8") as handle:
    json.dump(caps, handle, indent=2, sort_keys=True)
    handle.write("\n")
' "$CAPS_PATH" "$destination_path" "$cost_brake_enabled"
}

maybe_preserve_partial_report() {
  local final_status="$1"
  local task_payload="$2"
  local iterations_observed="$3"
  local max_turns="$4"
  local max_cost_usd="$5"
  local idle_timeout_seconds="$6"
  local max_wall_seconds="$7"
  local min_iteration_floor="$8"
  local confidence_threshold="$9"
  local saturation_threshold="${10}"
  local report_path
  local research_task

  if [[ ! "$final_status" =~ $PARTIAL_REPORT_REASONS_REGEX ]]; then
    return 0
  fi

  report_path="$(extract_report_destination "$task_payload")"
  research_task="$(extract_research_task "$task_payload")"
  append_partial_report \
    "$report_path" \
    "$research_task" \
    "$final_status" \
    "$iterations_observed" \
    "$max_turns" \
    "$max_cost_usd" \
    "$idle_timeout_seconds" \
    "$max_wall_seconds" \
    "$min_iteration_floor" \
    "$confidence_threshold" \
    "$saturation_threshold" \
    "External guard stopped the run before the final report completed."
}

write_modeb_metadata() {
  local session_child_pid="$1"

  if [[ -z "$modeb_metadata_path" ]]; then
    return 0
  fi

  mkdir -p "$(dirname "$modeb_metadata_path")"
  cat > "$modeb_metadata_path" <<EOF
modeb_pid=$$
session_child_pid=$session_child_pid
fifo_path=$fifo_path
work_dir=$work_dir
EOF
}

cleanup() {
  local saved_status="${1:-$?}"
  trap - EXIT INT TERM
  set +e

  if [[ -n "$launcher_pid" && -n "$session_child_pid_path" ]]; then
    child_pid="$(read_session_child_pid "$session_child_pid_path" "$launcher_pid")"
  fi

  if [[ -n "$monitor_pid" ]] && kill -0 "$monitor_pid" 2>/dev/null; then
    kill "$monitor_pid" 2>/dev/null
  fi

  if [[ -n "$monitor_pid" ]]; then
    wait "$monitor_pid" 2>/dev/null
  fi

  if [[ "$child_waited" -eq 0 && -n "$child_pid" ]] && kill -0 "$child_pid" 2>/dev/null; then
    terminate_child "$child_pid"
  fi

  if [[ "$child_waited" -eq 0 && -n "$launcher_pid" ]]; then
    wait "$launcher_pid" 2>/dev/null
  fi

  if [[ -n "$job_id" ]]; then
    run_job_release_hook "$job_id" "$modeb_final_status"
  fi

  if [[ -n "$work_dir" ]]; then
    if [[ -s "$log_path" ]]; then
      mkdir -p "$HOME/.hermes/results" 2>/dev/null || true
      cp "$log_path" "$(durable_log_path)" 2>/dev/null || true
    fi
    rm -rf "$work_dir"
  fi

  exit "$saved_status"
}

handle_signal() {
  local signal_status="$1"

  set_stop_reason "cancelled" || true
  modeb_final_status="cancelled"
  cleanup "$signal_status"
}

activity_monitor_loop() {
  # Scoped to the background monitor subshell; do not remove, termination depends on surviving transient command failures.
  set +e

  local target_pid="$1"
  local registry_job_id="$2"
  local idle_timeout_seconds="$3"
  local max_wall_seconds="$4"
  local max_turns="$5"
  local launch_epoch="$6"
  local preexisting_ids_path="$7"
  local launch_marker="$8"
  local session_label="${9:-}"
  local start_epoch
  local last_activity_epoch
  local previous_activity_key=""
  local row_id=""
  local current_epoch
  local metrics
  local api_call_count
  local output_tokens
  local observed_cost
  local activity_key
  local resolved_row_id=""
  local -i resolved_poll_interval
  local -i poll_interval

  start_epoch="$launch_epoch"
  last_activity_epoch="$launch_epoch"
  resolved_poll_interval=$(( idle_timeout_seconds / 2 ))
  if (( resolved_poll_interval < 2 )); then
    resolved_poll_interval=2
  elif (( resolved_poll_interval > 15 )); then
    resolved_poll_interval=15
  fi

  while kill -0 "$target_pid" 2>/dev/null; do
    poll_interval=2
    if [[ -n "$resolved_row_id" ]]; then
      poll_interval="$resolved_poll_interval"
    fi

    sleep "$poll_interval"
    current_epoch="$(date +%s)"

    if (( current_epoch - start_epoch >= max_wall_seconds )); then
      terminate_child "$target_pid"
      set_stop_reason "wall-clock-exceeded" || true
      return 0
    fi

    row_id="$(resolve_row_id "$launch_epoch" "$preexisting_ids_path" "$launch_marker")" || row_id=""
    if [[ "$row_id" != "$resolved_row_id" ]]; then
      previous_activity_key=""
      if [[ -n "$row_id" ]]; then
        last_activity_epoch="$current_epoch"
      fi
    fi
    resolved_row_id="$row_id"

    if [[ -z "$row_id" ]]; then
      if (( current_epoch - last_activity_epoch >= idle_timeout_seconds )); then
        terminate_child "$target_pid"
        set_stop_reason "idle-killed" || true
        return 0
      fi
      continue
    fi

    metrics="$(query_row_metrics "$row_id" 2>/dev/null)" || metrics="0 0 0"
    read -r api_call_count output_tokens observed_cost <<< "$metrics" || true
    api_call_count="${api_call_count:-0}"
    output_tokens="${output_tokens:-0}"
    observed_cost="${observed_cost:-0}"
    activity_key="${api_call_count}:${output_tokens}"

    if (( api_call_count >= max_turns )); then
      terminate_child "$target_pid"
      set_stop_reason "turn-cap-exceeded" || true
      return 0
    fi

    if [[ "$activity_key" != "$previous_activity_key" ]]; then
      run_job_touch_hook "$registry_job_id" "$target_pid" "$session_label" "running" || true
      previous_activity_key="$activity_key"
      last_activity_epoch="$current_epoch"
      continue
    fi

    if (( current_epoch - last_activity_epoch >= idle_timeout_seconds )); then
      terminate_child "$target_pid"
      set_stop_reason "idle-killed" || true
      return 0
    fi
  done
}

classify_status() {
  local wait_status="$1"
  local stop_reason=""

  if [[ -s "$reason_path" ]]; then
    stop_reason="$(< "$reason_path")"
    printf '%s\n' "$stop_reason"
    return 0
  fi

  if grep -Eiq 'max[ -]?turn|turn cap|maximum.*turn' "$log_path" 2>/dev/null; then
    printf 'turn-cap-exceeded\n'
    return 0
  fi

  if [[ "$wait_status" -eq 124 || "$wait_status" -eq 137 ]]; then
    printf 'wall-clock-exceeded\n'
    return 0
  fi

  if [[ "$wait_status" -eq 0 ]]; then
    printf 'completed\n'
    return 0
  fi

  printf 'hermes-error\n'
}

print_final_report() {
  local final_status="$1"
  local session_name="$2"
  local wait_status="$3"
  local launch_epoch="$4"
  local preexisting_ids_path="$5"
  local launch_marker="$6"
  local cost_brake_enabled="$7"
  local observed_cost
  local cost_note="post-hoc; no live cost-kill; bounded by preflight ceiling, turn, idle, and wall caps"

  if [[ "$cost_brake_enabled" == "true" ]]; then
    observed_cost="$(query_session_cost "$launch_epoch" "$preexisting_ids_path" "$launch_marker")"
  else
    observed_cost="0"
    cost_note="post-hoc; no live cost-kill; preflight cost ceiling disabled; bounded by turn, idle, and wall caps"
  fi

  printf 'status=%s\n' "$final_status"
  printf 'job_id=%s\n' "$job_id"
  printf 'session=%s\n' "$session_name"
  printf 'observed_cost_usd=%s\n' "$observed_cost"
  printf 'cost_note=%s\n' "$cost_note"
  printf 'output_location=%s\n' "$(durable_log_path)"
  printf 'hermes_exit_code=%s\n' "$wait_status"
}

main() {
  local account="default"
  local session_name
  local provider="$DEFAULT_PROVIDER"
  local model="$DEFAULT_MODEL"
  local max_turns
  local max_cost_usd
  local idle_timeout_seconds
  local max_wall_seconds
  local min_iteration_floor
  local confidence_threshold
  local saturation_threshold
  local cost_brake_enabled
  local task=""
  local model_route=""
  local caps_values=()
  local preflight_exit=0
  local child_exit=0
  local final_status
  local final_exit
  local launch_epoch
  local launch_marker
  local task_payload
  local hard_wall_seconds
  local fifo_handshake_timeout_seconds
  local preflight_refusal_note="Preflight cost brake refused the launch before Hermes started."

  session_name="modeb-$(date -u +%Y%m%dT%H%M%SZ)"

  mapfile -t caps_values < <(read_caps_defaults)
  max_turns="${caps_values[0]}"
  max_cost_usd="${caps_values[1]}"
  idle_timeout_seconds="${caps_values[2]}"
  max_wall_seconds="${caps_values[3]}"
  min_iteration_floor="${caps_values[4]}"
  confidence_threshold="${caps_values[5]}"
  saturation_threshold="${caps_values[6]}"
  cost_brake_enabled="${caps_values[7]}"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --model)
        shift
        [[ $# -gt 0 ]] || { echo "--model requires an argument" >&2; return 1; }
        model_route="$1"
        ;;
      --account)
        shift
        [[ $# -gt 0 ]] || { echo "--account requires an argument" >&2; return 1; }
        account="$1"
        ;;
      --session)
        shift
        [[ $# -gt 0 ]] || { echo "--session requires an argument" >&2; return 1; }
        session_name="$1"
        ;;
      --max-turns)
        shift
        [[ $# -gt 0 ]] || { echo "--max-turns requires an argument" >&2; return 1; }
        max_turns="$1"
        ;;
      --max-cost-usd)
        shift
        [[ $# -gt 0 ]] || { echo "--max-cost-usd requires an argument" >&2; return 1; }
        max_cost_usd="$1"
        ;;
      --idle-timeout)
        shift
        [[ $# -gt 0 ]] || { echo "--idle-timeout requires an argument" >&2; return 1; }
        idle_timeout_seconds="$1"
        ;;
      --max-wall-seconds)
        shift
        [[ $# -gt 0 ]] || { echo "--max-wall-seconds requires an argument" >&2; return 1; }
        max_wall_seconds="$1"
        ;;
      --help|-h)
        usage
        return 0
        ;;
      --)
        shift
        task="$*"
        break
        ;;
      -*)
        echo "unknown flag: $1" >&2
        usage >&2
        return 1
        ;;
      *)
        task="$*"
        break
        ;;
    esac
    shift
  done

  if [[ -n "$model_route" ]]; then
    split_model_route "$model_route" provider model
  fi
  reject_retired_provider "$provider" || return 1

  if [[ -z "$task" ]]; then
    echo "modeb.sh requires a task argument" >&2
    usage >&2
    return 1
  fi

  if ! is_positive_integer "$max_turns"; then
    echo "--max-turns must be a positive integer" >&2
    return 1
  fi

  if ! is_positive_integer "$idle_timeout_seconds"; then
    echo "--idle-timeout must be a positive integer" >&2
    return 1
  fi

  if ! is_positive_integer "$max_wall_seconds"; then
    echo "--max-wall-seconds must be a positive integer" >&2
    return 1
  fi

  if ! is_positive_number "$max_cost_usd"; then
    echo "--max-cost-usd must be a positive number" >&2
    return 1
  fi

  if ! is_positive_integer "$min_iteration_floor"; then
    echo "min_iteration_floor must be a positive integer" >&2
    return 1
  fi

  if ! is_positive_integer "$confidence_threshold" || (( confidence_threshold > 100 )); then
    echo "confidence_threshold must be an integer between 1 and 100" >&2
    return 1
  fi

  if ! is_positive_integer "$saturation_threshold"; then
    echo "saturation_threshold must be a positive integer" >&2
    return 1
  fi

  if [[ "$cost_brake_enabled" != "true" && "$cost_brake_enabled" != "false" ]]; then
    echo "cost_brake_enabled must be true or false" >&2
    return 1
  fi

  if [[ -n "$MODEB_FIFO_HANDSHAKE_TIMEOUT_SECONDS" ]] && ! is_positive_integer "$MODEB_FIFO_HANDSHAKE_TIMEOUT_SECONDS"; then
    echo "HERMES_MODEB_FIFO_HANDSHAKE_TIMEOUT_SECONDS must be a positive integer" >&2
    return 1
  fi

  work_dir="$(mktemp -d "${TMPDIR:-/tmp}/hermes-modeb.XXXXXX")"
  fifo_path="$work_dir/start.fifo"
  preexisting_ids_path="$work_dir/preexisting_ids"
  log_path="$work_dir/hermes.log"
  preflight_stdout_path="$work_dir/preflight.stdout.json"
  preflight_stderr_path="$work_dir/preflight.stderr"
  preflight_caps_path="$work_dir/preflight_caps.json"
  prelaunch_payload_path="$work_dir/prelaunch.json"
  session_child_pid_path="$work_dir/session-child.pid"
  reason_path="$work_dir/stop.reason"
  reason_lock_path="$work_dir/stop.reason.lock"

  mkfifo "$fifo_path"
  : > "$log_path"
  trap 'handle_signal 130' INT
  trap 'handle_signal 143' TERM
  trap 'cleanup $?' EXIT

  launch_epoch="$(date +%s)"
  launch_marker="$(build_launch_marker)"
  hard_wall_seconds=$(( max_wall_seconds + MODEB_KILL_GRACE_SECONDS ))
  fifo_handshake_timeout_seconds="$hard_wall_seconds"
  if [[ -n "$MODEB_FIFO_HANDSHAKE_TIMEOUT_SECONDS" ]]; then
    fifo_handshake_timeout_seconds="$MODEB_FIFO_HANDSHAKE_TIMEOUT_SECONDS"
  fi
  task_payload="$(build_task_payload \
    "$launch_marker" \
    "$task" \
    "$max_turns" \
    "$max_cost_usd" \
    "$idle_timeout_seconds" \
    "$max_wall_seconds" \
    "$min_iteration_floor" \
    "$confidence_threshold" \
    "$saturation_threshold")"
  write_preflight_caps "$preflight_caps_path" "$cost_brake_enabled"

  if prelaunch_hook_misconfigured; then
    preflight_exit=2
    preflight_refusal_note="Prelaunch hook is configured but not executable: $HERMES_HOOK_PRELAUNCH"
    printf 'prelaunch hook misconfigured; refusing launch: %s\n' "$HERMES_HOOK_PRELAUNCH" >&2
  elif prelaunch_hook_available; then
    write_prelaunch_payload \
      "$prelaunch_payload_path" \
      "$preflight_caps_path" \
      "$account" \
      "$provider" \
      "$model" \
      "$$" \
      "$max_turns" \
      "$max_cost_usd" \
      "$idle_timeout_seconds" \
      "$max_wall_seconds" \
      "$task_payload"
    if "$HERMES_HOOK_PRELAUNCH" \
      < "$prelaunch_payload_path" \
      > "$preflight_stdout_path" \
      2> "$preflight_stderr_path"; then
      preflight_exit=0
    else
      preflight_exit=2
    fi
  else
    preflight_exit=0
    if [[ "$cost_brake_enabled" == "true" ]]; then
      preflight_exit=2
      preflight_refusal_note="Cost brake was requested, but no prelaunch hook is configured, so launch was refused before Hermes started."
      echo "prelaunch hook unavailable; refusing cost-braked launch" >&2
    fi
  fi

  if [[ "$preflight_exit" -ne 0 ]]; then
    write_preflight_refusal_artifacts \
      "$preflight_exit" \
      "$task_payload" \
      "$max_turns" \
      "$max_cost_usd" \
      "$idle_timeout_seconds" \
      "$max_wall_seconds" \
      "$min_iteration_floor" \
      "$confidence_threshold" \
      "$saturation_threshold" \
      "$preflight_refusal_note"
    echo "preflight refused modeb launch" >&2
    if [[ -s "$preflight_stderr_path" ]]; then
      sed 's/^/preflight: /' "$preflight_stderr_path" >&2
    fi
    if [[ -s "$preflight_stdout_path" ]]; then
      sed 's/^/preflight-json: /' "$preflight_stdout_path" >&2
    fi
    return "$preflight_exit"
  fi

  job_id="$(extract_prelaunch_job_id "$preflight_stdout_path")"
  if [[ -z "$job_id" ]]; then
    job_id="$(generate_job_id)"
  fi
  run_job_touch_hook "$job_id" "$$" "$session_name" "running" || true

  setsid --wait bash -c '
    trap - EXIT INT TERM
    printf "%s\n" "$$" > "${11}"
    if ! timeout "${10}" bash -c '\''IFS= read -r _ < "$1"'\'' modeb-fifo "$1"; then
      exit 124
    fi
    cd "$2" || exit 1
    exec timeout -k "$3" "$4" env HERMES_MAX_ITERATIONS="$5" "${12}" \
      -z "$6" \
      --continue "$7" \
      --yolo \
      --provider "$8" \
      -m "$9"
  ' modeb-child \
    "$fifo_path" \
    "$HERMES_WORKDIR" \
    "$MODEB_KILL_GRACE_SECONDS" \
    "$hard_wall_seconds" \
    "$max_turns" \
    "$task_payload" \
    "$session_name" \
    "$provider" \
    "$model" \
    "$fifo_handshake_timeout_seconds" \
    "$session_child_pid_path" \
    "$HERMES_BIN" \
    > "$log_path" 2>&1 &
  launcher_pid="$!"
  child_pid="$(read_session_child_pid "$session_child_pid_path" "$launcher_pid")"
  wait_for_session_leader "$child_pid"
  write_modeb_metadata "$child_pid"

  sqlite3 "$HERMES_STATE_DB" "SELECT id FROM sessions;" > "$preexisting_ids_path" 2>/dev/null || : > "$preexisting_ids_path"
  printf 'start\n' > "$fifo_path"

  ( trap - EXIT INT TERM; activity_monitor_loop "$child_pid" "$job_id" "$idle_timeout_seconds" "$max_wall_seconds" "$max_turns" "$launch_epoch" "$preexisting_ids_path" "$launch_marker" "$session_name" ) &
  monitor_pid="$!"

  set +e
  wait "$launcher_pid"
  child_exit="$?"
  set -e
  child_waited=1

  if [[ "$child_exit" -ne 0 && -n "$monitor_pid" ]]; then
    wait "$monitor_pid" 2>/dev/null || true
    monitor_pid=""
  fi

  if record_final_activity "$job_id" "$launch_epoch" "$preexisting_ids_path" "$launch_marker" "$session_name"; then
    sleep 3
  fi

  local resolved_row_id=""
  local final_turn_count="0"
  final_status="$(classify_status "$child_exit")"
  modeb_final_status="$final_status"
  resolved_row_id="$(resolve_row_id "$launch_epoch" "$preexisting_ids_path" "$launch_marker")"
  if [[ -n "$resolved_row_id" ]]; then
    final_turn_count="$(query_row_metrics "$resolved_row_id" | awk '{print $1}')"
  fi
  maybe_preserve_partial_report \
    "$final_status" \
    "$task_payload" \
    "$final_turn_count" \
    "$max_turns" \
    "$max_cost_usd" \
    "$idle_timeout_seconds" \
    "$max_wall_seconds" \
    "$min_iteration_floor" \
    "$confidence_threshold" \
    "$saturation_threshold"
  print_final_report "$final_status" "$session_name" "$child_exit" "$launch_epoch" "$preexisting_ids_path" "$launch_marker" "$cost_brake_enabled"

  final_exit="$child_exit"
  if [[ "$final_status" != "completed" && "$final_exit" -eq 0 ]]; then
    final_exit=1
  fi

  return "$final_exit"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi

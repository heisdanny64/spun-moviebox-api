#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-https://moviebox.byspun.xyz}"
WORKER_SECRET="${WORKER_SECRET:-${MOVIEBOX_WORKER_SECRET:-}}"
REQUEST_TIMEOUT="${REQUEST_TIMEOUT:-90}"
RUN_EXPENSIVE="${RUN_EXPENSIVE:-0}"
SUBJECT_ID="${SUBJECT_ID:-}"

if [[ -z "$WORKER_SECRET" ]]; then
  echo "ERROR: set WORKER_SECRET or MOVIEBOX_WORKER_SECRET before running this script." >&2
  echo "Example: WORKER_SECRET='your-secret' bash scripts/smoke-test.sh" >&2
  exit 2
fi

BASE_URL="${BASE_URL%/}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
LAST_BODY_FILE=''

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf 'PASS  %s\n' "$1"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  printf 'FAIL  %s — %s\n' "$1" "$2"
}

skip() {
  SKIP_COUNT=$((SKIP_COUNT + 1))
  printf 'SKIP  %s — %s\n' "$1" "$2"
}

body_name() {
  printf '%s' "$1" | tr ' /?' '___'
}

request() {
  local name="$1"
  local method="$2"
  local path="$3"
  local expected_status="$4"
  local body_file="$TMP_DIR/$(body_name "$name").body"
  local status
  local curl_args=(
    --silent --show-error --location
    --connect-timeout 10 --max-time "$REQUEST_TIMEOUT"
    --output "$body_file" --write-out '%{http_code}'
    --request "$method" "$BASE_URL$path"
  )

  LAST_BODY_FILE="$body_file"

  if [[ "$name" != "health" && "$name" != "root" ]]; then
    curl_args+=(--header "X-Worker-Secret: $WORKER_SECRET")
  fi

  status="$(curl "${curl_args[@]}" 2>"$TMP_DIR/$(body_name "$name").err" || printf '000')"
  if [[ "$status" != "$expected_status" ]]; then
    local detail
    detail="$(head -c 240 "$body_file" 2>/dev/null || true)"
    fail "$name" "HTTP $status (expected $expected_status): $detail"
    return 1
  fi

  if grep -qE '"error"[[:space:]]*:' "$body_file"; then
    local detail
    detail="$(head -c 240 "$body_file" 2>/dev/null || true)"
    fail "$name" "HTTP $status returned an error envelope: $detail"
    return 1
  fi

  pass "$name (HTTP $status, $(wc -c < "$body_file") bytes)"
}

request_with_body() {
  local name="$1"
  local method="$2"
  local path="$3"
  local expected_status="$4"
  local request_body="$5"
  local body_file="$TMP_DIR/$(body_name "$name").body"
  local status

  LAST_BODY_FILE="$body_file"
  status="$(curl --silent --show-error --location \
    --connect-timeout 10 --max-time "$REQUEST_TIMEOUT" \
    --output "$body_file" --write-out '%{http_code}' \
    --request "$method" "$BASE_URL$path" \
    --header "X-Worker-Secret: $WORKER_SECRET" \
    --header 'Content-Type: application/json' \
    --data "$request_body" 2>"$TMP_DIR/$(body_name "$name").err" || printf '000')"

  if [[ "$status" != "$expected_status" ]]; then
    local detail
    detail="$(head -c 240 "$body_file" 2>/dev/null || true)"
    fail "$name" "HTTP $status (expected $expected_status): $detail"
    return 1
  fi

  if grep -qE '"error"[[:space:]]*:' "$body_file"; then
    local detail
    detail="$(head -c 240 "$body_file" 2>/dev/null || true)"
    fail "$name" "HTTP $status returned an error envelope: $detail"
    return 1
  fi

  pass "$name (HTTP $status, $(wc -c < "$body_file") bytes)"
}

extract_first_value() {
  local key="$1"
  local file="$2"
  grep -oE "\"${key}\"[[:space:]]*:[[:space:]]*\"[^\"]+\"" "$file" \
    | head -n 1 \
    | sed -E 's/^[^:]+:[[:space:]]*"(.*)"$/\1/'
}

printf 'Moviebox smoke test\nBase URL: %s\n\n' "$BASE_URL"

if request health GET /health 200; then
  if ! grep -q '"status"[[:space:]]*:[[:space:]]*"ok"' "$LAST_BODY_FILE"; then
    fail 'health payload' 'expected status=ok'
  fi
fi

if request root GET / 200; then
  if ! grep -q 'MovieBox' "$LAST_BODY_FILE"; then
    fail 'root payload' 'expected API information containing MovieBox'
  fi
fi

search_file=''
if request_with_body 'search' POST /search 200 '{"keyword":"The Last of Us","page":1,"perPage":3}'; then
  search_file="$LAST_BODY_FILE"
  SUBJECT_ID="${SUBJECT_ID:-$(extract_first_value subjectId "$search_file")}" || true
fi

if [[ -z "$SUBJECT_ID" ]]; then
  fail 'subject discovery' 'search response did not contain a subjectId; dependent tests skipped'
else
  printf 'Using subject ID: %s\n\n' "$SUBJECT_ID"
  request "info_$SUBJECT_ID" GET "/info/$SUBJECT_ID" 200 || true
  request "season_$SUBJECT_ID" GET "/season/$SUBJECT_ID" 200 || true
fi

if request home_rows GET /home/rows 200; then
  op_id="$(extract_first_value opId "$LAST_BODY_FILE")" || true
  if [[ -n "${op_id:-}" ]]; then
    request "home_subjects_$op_id" GET "/home/subjects?opId=$op_id" 200 || true
  else
    fail 'home subject discovery' 'home/rows response did not contain an opId'
  fi
fi

request home GET /home 200 || true

if [[ "$RUN_EXPENSIVE" == "1" && -n "$SUBJECT_ID" ]]; then
  request "stream_${SUBJECT_ID}" GET "/stream/$SUBJECT_ID?se=1&ep=1" 200 || true
  request "stream_all_${SUBJECT_ID}" GET "/stream/$SUBJECT_ID/all" 200 || true
  request "download_${SUBJECT_ID}" GET "/download/$SUBJECT_ID" 200 || true
else
  skip 'stream/download routes' 'set RUN_EXPENSIVE=1 to exercise resource-heavy routes'
fi

printf '\nSummary: %d passed, %d failed, %d skipped\n' "$PASS_COUNT" "$FAIL_COUNT" "$SKIP_COUNT"
if [[ "$FAIL_COUNT" -gt 0 ]]; then
  exit 1
fi

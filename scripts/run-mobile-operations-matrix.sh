#!/usr/bin/env bash
set -uo pipefail

: "${EVIDENCE_ROOT:?EVIDENCE_ROOT must identify the native matrix evidence directory}"

run_surface() {
  local surface="$1"
  NODE_OPTIONS=--max-old-space-size=2048 \
    PASEO_MOBILE_E2E_ARTIFACTS_DIR="${EVIDENCE_ROOT}/${surface}" \
    PASEO_MOBILE_E2E_JUNIT_PATH="${EVIDENCE_ROOT}/${surface}/junit.xml" \
    npm run "test:e2e:mobile:${surface}"
}

run_surface operations
operations_status=$?
run_surface visual
visual_status=$?
run_surface teams
teams_status=$?

if [[ "${operations_status}" -ne 0 || "${visual_status}" -ne 0 || "${teams_status}" -ne 0 ]]; then
  echo "Native matrix failed: operations=${operations_status} visual=${visual_status} teams=${teams_status}" >&2
  exit 1
fi

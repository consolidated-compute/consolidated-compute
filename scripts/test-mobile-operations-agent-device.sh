#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MATRIX_SURFACE="${PASEO_MOBILE_E2E_MATRIX_SURFACE:-operations}"
PLATFORM="${PASEO_MOBILE_E2E_PLATFORM:-ios}"
DEVICE="${PASEO_MOBILE_E2E_DEVICE:-}"
SERIAL="${PASEO_MOBILE_E2E_SERIAL:-}"
APP_ID="${PASEO_MOBILE_E2E_APP_ID:-sh.paseo.debug}"
OPERATIONS_FIXTURE="${PASEO_MOBILE_E2E_OPERATIONS_FIXTURE:-1}"
SUITE_PATH="${PASEO_MOBILE_E2E_SUITE:-${REPO_ROOT}/packages/app/e2e/mobile/agent-device}"
DEV_CLIENT_FLOW="${REPO_ROOT}/packages/app/e2e/mobile/native-matrix-dev-client.yaml"
AGENT_DEVICE_BIN="${REPO_ROOT}/node_modules/.bin/agent-device"
METRO_PID=0
METRO_LOG_PATH=""
FIXTURE_PID=0
RESET_DEVICE_SETTINGS=0
CAPTURE_AGENT_DEVICE_SESSIONS=0

case "${MATRIX_SURFACE}" in
  operations)
    DEFAULT_STATE_DIR="${REPO_ROOT}/.dev/operations-agent-device-e2e"
    DEFAULT_ARTIFACTS_DIR="${REPO_ROOT}/.dev/operations-agent-device-artifacts"
    DEFAULT_METRO_PORT=8082
    ;;
  visual)
    DEFAULT_STATE_DIR="${REPO_ROOT}/.dev/visual-agent-device-e2e"
    DEFAULT_ARTIFACTS_DIR="${REPO_ROOT}/.dev/visual-agent-device-artifacts"
    DEFAULT_METRO_PORT=8083
    ;;
  teams)
    DEFAULT_STATE_DIR="${REPO_ROOT}/.dev/teams-agent-device-e2e"
    DEFAULT_ARTIFACTS_DIR="${REPO_ROOT}/.dev/teams-agent-device-artifacts"
    DEFAULT_METRO_PORT=8084
    ;;
  *)
    echo "PASEO_MOBILE_E2E_MATRIX_SURFACE must be operations, visual, or teams (received ${MATRIX_SURFACE})." >&2
    exit 2
    ;;
esac

if [[ "${MATRIX_SURFACE}" == "visual" ]]; then
  export EXPO_PUBLIC_PASEO_E2E_VISUAL_MOTION_PROBE=1
  # The hosted devices expose different system animation controls. Exercise the
  # same presentation path on both without changing production bundles.
  export EXPO_PUBLIC_PASEO_E2E_FORCE_VISUAL_REDUCED_MOTION=1
fi

if [[ "${OPERATIONS_FIXTURE}" == "1" ]]; then
  # Push registration is outside these surface contracts, and its native
  # permission prompt is not deterministic across simulator runtimes.
  export EXPO_PUBLIC_PASEO_E2E_DISABLE_PUSH_NOTIFICATIONS=1
fi

STATE_DIR="${PASEO_MOBILE_E2E_STATE_DIR:-${DEFAULT_STATE_DIR}}"
ARTIFACTS_DIR="${PASEO_MOBILE_E2E_ARTIFACTS_DIR:-${DEFAULT_ARTIFACTS_DIR}}"
METRO_PORT="${PASEO_MOBILE_E2E_METRO_PORT:-${DEFAULT_METRO_PORT}}"

case "${PLATFORM}" in
  ios | android) ;;
  *)
    echo "PASEO_MOBILE_E2E_PLATFORM must be ios or android (received ${PLATFORM})." >&2
    exit 2
    ;;
esac

if [[ ! -x "${AGENT_DEVICE_BIN}" ]]; then
  echo "The pinned agent-device dependency is missing. Run npm ci before the mobile suite." >&2
  exit 2
fi

cleanup() {
  if [[ "${FIXTURE_PID}" -gt 0 ]]; then
    kill -TERM "${FIXTURE_PID}" >/dev/null 2>&1 || true
    wait "${FIXTURE_PID}" >/dev/null 2>&1 || true
  fi
  if [[ "${RESET_DEVICE_SETTINGS}" -eq 1 ]]; then
    if [[ "${PLATFORM}" == "ios" ]]; then
      xcrun simctl ui booted content_size large >/dev/null 2>&1 || true
      xcrun simctl ui booted appearance light >/dev/null 2>&1 || true
    else
      AGENT_DEVICE_STATE_DIR="${STATE_DIR}" "${AGENT_DEVICE_BIN}" settings animations on \
        >/dev/null 2>&1 || true
      if command -v adb >/dev/null 2>&1; then
        adb shell settings put system font_scale 1.0 >/dev/null 2>&1 || true
        adb shell cmd uimode night no >/dev/null 2>&1 || true
      fi
    fi
  fi
  if [[ -n "${METRO_LOG_PATH}" && -f "${METRO_LOG_PATH}" ]]; then
    cp "${METRO_LOG_PATH}" "${ARTIFACTS_DIR}/metro.log" >/dev/null 2>&1 || true
  fi
  if [[ "${CAPTURE_AGENT_DEVICE_SESSIONS}" -eq 1 && -d "${STATE_DIR}/sessions" ]]; then
    mkdir -p "${ARTIFACTS_DIR}/agent-device-sessions"
    cp -R "${STATE_DIR}/sessions/." "${ARTIFACTS_DIR}/agent-device-sessions/" \
      >/dev/null 2>&1 || true
  fi
  AGENT_DEVICE_STATE_DIR="${STATE_DIR}" "${AGENT_DEVICE_BIN}" daemon stop --clean >/dev/null 2>&1 || true
  if [[ "${METRO_PID}" -gt 0 ]]; then
    pkill -TERM -P "${METRO_PID}" >/dev/null 2>&1 || true
    kill -TERM "${METRO_PID}" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT INT TERM
cleanup
mkdir -p "${STATE_DIR}" "${ARTIFACTS_DIR}"

DEVICE_HOST="${PASEO_MOBILE_E2E_DEVICE_HOST:-}"
if [[ -z "${DEVICE_HOST}" ]]; then
  if [[ "${PLATFORM}" == "android" ]]; then
    DEVICE_HOST="10.0.2.2"
  else
    DEVICE_HOST="127.0.0.1"
  fi
fi

if [[ "${OPERATIONS_FIXTURE}" == "1" ]]; then
  FIXTURE_LOG="${ARTIFACTS_DIR}/operations-fixture.log"
  E2E_METRO_PORT="${METRO_PORT}" npx tsx "${REPO_ROOT}/scripts/mobile-operations-fixture.ts" \
    >"${FIXTURE_LOG}" 2>&1 &
  FIXTURE_PID=$!

  FIXTURE_LINE=""
  for _ in $(seq 1 300); do
    FIXTURE_LINE="$(grep -m 1 '^PASEO_MOBILE_OPERATIONS_FIXTURE=' "${FIXTURE_LOG}" || true)"
    if [[ -n "${FIXTURE_LINE}" ]]; then
      break
    fi
    if ! kill -0 "${FIXTURE_PID}" >/dev/null 2>&1; then
      sed -n '1,240p' "${FIXTURE_LOG}" >&2
      echo "Operations fixture exited before becoming ready." >&2
      exit 1
    fi
    sleep 0.1
  done
  if [[ -z "${FIXTURE_LINE}" ]]; then
    sed -n '1,240p' "${FIXTURE_LOG}" >&2
    echo "Timed out waiting for the Operations fixture." >&2
    exit 1
  fi

  FIXTURE_JSON="${FIXTURE_LINE#PASEO_MOBILE_OPERATIONS_FIXTURE=}"
  FIXTURE_VALUES="$(node -e '
    const fixture = JSON.parse(process.argv[1]);
    process.stdout.write([
      fixture.primary.port,
      fixture.primary.serverId,
      fixture.primary.workspaceId,
      fixture.primary.parentAgentId,
      fixture.primary.providerSubagentId,
      fixture.primary.teamId,
      fixture.primary.teamRoleId,
      fixture.primary.teamStepId,
      fixture.secondary.port,
      fixture.secondary.serverId,
      fixture.secondary.workspaceId,
      fixture.secondary.agentId,
      fixture.secondary.providerSubagentId,
    ].join("\t"));
  ' "${FIXTURE_JSON}")"
  IFS=$'\t' read -r \
    PRIMARY_PORT \
    PRIMARY_SERVER_ID \
    PRIMARY_WORKSPACE_ID \
    PRIMARY_AGENT_ID \
    PRIMARY_PROVIDER_SUBAGENT_ID \
    PRIMARY_TEAM_ID \
    PRIMARY_TEAM_ROLE_ID \
    PRIMARY_TEAM_STEP_ID \
    SECONDARY_PORT \
    SECONDARY_SERVER_ID \
    SECONDARY_WORKSPACE_ID \
    SECONDARY_AGENT_ID \
    SECONDARY_PROVIDER_SUBAGENT_ID <<<"${FIXTURE_VALUES}"

  export AD_VAR_PRIMARY_SERVER_ID="${PRIMARY_SERVER_ID}"
  export AD_VAR_PRIMARY_WORKSPACE_ID="${PRIMARY_WORKSPACE_ID}"
  export AD_VAR_PRIMARY_AGENT_ID="${PRIMARY_AGENT_ID}"
  export AD_VAR_PRIMARY_PROVIDER_SUBAGENT_ID="${PRIMARY_PROVIDER_SUBAGENT_ID}"
  export AD_VAR_PRIMARY_TEAM_ID="${PRIMARY_TEAM_ID}"
  export AD_VAR_PRIMARY_TEAM_ROLE_ID="${PRIMARY_TEAM_ROLE_ID}"
  export AD_VAR_PRIMARY_TEAM_STEP_ID="${PRIMARY_TEAM_STEP_ID}"
  export AD_VAR_SECONDARY_HOST="${DEVICE_HOST}"
  export AD_VAR_SECONDARY_PORT="${SECONDARY_PORT}"
  export AD_VAR_SECONDARY_SERVER_ID="${SECONDARY_SERVER_ID}"
  export AD_VAR_SECONDARY_WORKSPACE_ID="${SECONDARY_WORKSPACE_ID}"
  export AD_VAR_SECONDARY_AGENT_ID="${SECONDARY_AGENT_ID}"
  export AD_VAR_SECONDARY_PROVIDER_SUBAGENT_ID="${SECONDARY_PROVIDER_SUBAGENT_ID}"
  export AD_VAR_APP_ID="${APP_ID}"
  export AD_VAR_METRO_HOST="${DEVICE_HOST}"
  export AD_VAR_METRO_PORT="${METRO_PORT}"
  export AD_VAR_DEV_CLIENT_URL="$(node -e '
    const baseUrl = process.argv[1];
    process.stdout.write(
      `exp+voice-mobile://expo-development-client/?url=${encodeURIComponent(baseUrl)}`,
    );
  ' "http://${DEVICE_HOST}:${METRO_PORT}")"
  export EXPO_PUBLIC_LOCAL_DAEMON="${DEVICE_HOST}:${PRIMARY_PORT}"
  SUITE_PATH="${REPO_ROOT}/packages/app/e2e/mobile/${MATRIX_SURFACE}-agent-device/${MATRIX_SURFACE}-matrix.${PLATFORM}.ad"
fi

METRO_RESULT="$({
  AGENT_DEVICE_STATE_DIR="${STATE_DIR}" "${AGENT_DEVICE_BIN}" metro prepare \
    --project-root "${REPO_ROOT}/packages/app" \
    --kind expo \
    --port "${METRO_PORT}" \
    --public-base-url "http://${DEVICE_HOST}:${METRO_PORT}" \
    --no-reuse-existing \
    --json
})"
printf '%s\n' "${METRO_RESULT}"
METRO_VALUES="$(printf '%s' "${METRO_RESULT}" | node -e '
  let input = "";
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => {
    const result = JSON.parse(input);
    const platform = process.argv[1];
    const runtime = platform === "ios" ? result.data?.iosRuntime : result.data?.androidRuntime;
    const bundleUrl = new URL(runtime?.bundleUrl);
    bundleUrl.hostname = "127.0.0.1";
    process.stdout.write([
      String(result.data?.started ? result.data.pid : 0),
      result.data?.logPath ?? "",
      bundleUrl.toString(),
    ].join("\t"));
  });
' "${PLATFORM}")"
IFS=$'\t' read -r METRO_PID METRO_LOG_PATH METRO_PREWARM_URL <<<"${METRO_VALUES}"

# Compile the platform bundle before opening the development client. Cold Expo
# bundles can take longer than the first UI assertion on hosted runners.
curl --fail --show-error --silent --retry 2 --retry-all-errors --max-time 300 \
  --output /dev/null \
  "${METRO_PREWARM_URL}"

TARGET_ARGS=(--platform "${PLATFORM}")
if [[ -n "${DEVICE}" ]]; then
  if [[ "${PLATFORM}" == "ios" ]]; then
    TARGET_ARGS+=(--udid "${DEVICE}")
  else
    TARGET_ARGS+=(--device "${DEVICE}")
  fi
fi
if [[ "${PLATFORM}" == "android" && -n "${SERIAL}" ]]; then
  TARGET_ARGS+=(--serial "${SERIAL}")
fi
AGENT_DEVICE_STATE_DIR="${STATE_DIR}" "${AGENT_DEVICE_BIN}" boot "${TARGET_ARGS[@]}"

if [[ "${OPERATIONS_FIXTURE}" == "1" ]]; then
  RESET_DEVICE_SETTINGS=1
  if [[ "${PLATFORM}" == "ios" ]]; then
    xcrun simctl ui booted content_size accessibility-extra-extra-extra-large
  else
    if ! command -v adb >/dev/null 2>&1; then
      echo "adb is required for the Android Operations matrix." >&2
      exit 2
    fi
    adb shell settings put system font_scale 1.3
  fi
fi

if [[ "${PLATFORM}" == "ios" ]]; then
  AGENT_DEVICE_STATE_DIR="${STATE_DIR}" "${AGENT_DEVICE_BIN}" prepare ios-runner \
    "${TARGET_ARGS[@]}" \
    --timeout 240000
fi

# Expo's development-client shell has platform- and runtime-dependent prompts.
# Reuse the repository's conditional Maestro choreography before the strict
# Agent Device replay starts asserting product state.
DEV_CLIENT_REPLAY_LOG="${ARTIFACTS_DIR}/dev-client-replay.log"
CAPTURE_AGENT_DEVICE_SESSIONS=1
AGENT_DEVICE_STATE_DIR="${STATE_DIR}" "${AGENT_DEVICE_BIN}" replay \
  "${DEV_CLIENT_FLOW}" \
  --maestro \
  "${TARGET_ARGS[@]}" \
  --metro-host "${DEVICE_HOST}" \
  --metro-port "${METRO_PORT}" \
  --timeout 180000 | tee "${DEV_CLIENT_REPLAY_LOG}"

DEV_CLIENT_SESSION="$(
  node -e '
    const output = require("node:fs").readFileSync(process.argv[1], "utf8");
    const sessions = Array.from(
      output.matchAll(/pass --session (\S+) on your next command/g),
      (match) => match[1],
    );
    if (sessions.length !== 1) {
      throw new Error(
        `Expected one scoped Agent Device replay session, found ${sessions.length}.`,
      );
    }
    process.stdout.write(sessions[0]);
  ' "${DEV_CLIENT_REPLAY_LOG}"
)"

# Maestro replay keeps its returned session active so callers can continue it.
# The matrix runner owns a fresh test session instead, so release the device.
AGENT_DEVICE_STATE_DIR="${STATE_DIR}" "${AGENT_DEVICE_BIN}" close --session "${DEV_CLIENT_SESSION}"

REPORTER_ARGS=(--reporter default)
if [[ -n "${PASEO_MOBILE_E2E_JUNIT_PATH:-}" ]]; then
  mkdir -p "$(dirname "${PASEO_MOBILE_E2E_JUNIT_PATH}")"
  REPORTER_ARGS+=(--reporter "junit:${PASEO_MOBILE_E2E_JUNIT_PATH}")
fi

AGENT_DEVICE_STATE_DIR="${STATE_DIR}" "${AGENT_DEVICE_BIN}" test \
  "${SUITE_PATH}" \
  "${TARGET_ARGS[@]}" \
  --metro-port "${METRO_PORT}" \
  --timeout 600000 \
  --fail-fast \
  "${REPORTER_ARGS[@]}" \
  --artifacts-dir "${ARTIFACTS_DIR}"

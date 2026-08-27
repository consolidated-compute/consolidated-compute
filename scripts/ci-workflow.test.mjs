import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { relative as relativePath } from "node:path";
import test from "node:test";

const repoRoot = new URL("../", import.meta.url);
const ciWorkflowPath = new URL(".github/workflows/ci.yml", repoRoot);
const dockerWorkflowPath = new URL(".github/workflows/docker.yml", repoRoot);
const nixWorkflowPath = new URL(".github/workflows/nix.yml", repoRoot);
const mobileOperationsWorkflowPath = new URL(".github/workflows/mobile-operations.yml", repoRoot);
const genericMobileRunnerPath = new URL("scripts/test-mobile-agent-device.sh", repoRoot);
const operationsMobileRunnerPath = new URL(
  "scripts/test-mobile-operations-agent-device.sh",
  repoRoot,
);
const operationsMatrixRunnerPath = new URL("scripts/run-mobile-operations-matrix.sh", repoRoot);
const nativeMatrixDevClientPath = new URL(
  "packages/app/e2e/mobile/native-matrix-dev-client.yaml",
  repoRoot,
);
const iosOperationsReplayPath = new URL(
  "packages/app/e2e/mobile/operations-agent-device/operations-matrix.ios.ad",
  repoRoot,
);
const androidOperationsReplayPath = new URL(
  "packages/app/e2e/mobile/operations-agent-device/operations-matrix.android.ad",
  repoRoot,
);
const iosTeamsReplayPath = new URL(
  "packages/app/e2e/mobile/teams-agent-device/teams-matrix.ios.ad",
  repoRoot,
);
const androidTeamsReplayPath = new URL(
  "packages/app/e2e/mobile/teams-agent-device/teams-matrix.android.ad",
  repoRoot,
);
const iosVisualReplayPath = new URL(
  "packages/app/e2e/mobile/visual-agent-device/visual-matrix.ios.ad",
  repoRoot,
);
const androidVisualReplayPath = new URL(
  "packages/app/e2e/mobile/visual-agent-device/visual-matrix.android.ad",
  repoRoot,
);
const upstreamReleaseMonitorPath = new URL(
  ".github/workflows/upstream-release-monitor.yml",
  repoRoot,
);
const filtersPath = new URL(".github/ci-paths.yml", repoRoot);
const serverTsconfigPath = new URL("packages/server/tsconfig.server.json", repoRoot);
const desktopPackagePath = new URL("packages/desktop/package.json", repoRoot);

const gatedCiJobs = new Map([
  ["format", { name: "format", contract: "format" }],
  ["lint", { name: "lint", contract: "quality" }],
  ["typecheck", { name: "typecheck", contract: "quality" }],
  ["server-tests-ubuntu", { name: "server-tests (ubuntu-latest)", contracts: ["server", "hub"] }],
  ["server-tests-windows", { name: "server-tests (windows-latest)", contracts: ["server", "hub"] }],
  ["desktop-tests-ubuntu", { name: "desktop-tests (ubuntu-latest)", contract: "desktop" }],
  ["desktop-tests-windows", { name: "desktop-tests (windows-latest)", contract: "desktop" }],
  ["app-tests", { name: "app-tests", contract: "app" }],
  ["sdk-tests", { name: "sdk-tests", contract: "sdk" }],
  ["playwright-1", { name: "playwright (shard 1/4)", contract: "browser" }],
  ["playwright-2", { name: "playwright (shard 2/4)", contract: "browser" }],
  ["playwright-3", { name: "playwright (shard 3/4)", contract: "browser" }],
  ["playwright-4", { name: "playwright (shard 4/4)", contract: "browser" }],
  ["relay-tests", { name: "relay-tests", contract: "relay" }],
  ["cli-tests-1", { name: "cli-tests (shard 1/3)", contract: "cli" }],
  ["cli-tests-2", { name: "cli-tests (shard 2/3)", contract: "cli" }],
  ["cli-tests-3", { name: "cli-tests (shard 3/3)", contract: "cli" }],
]);

const quarantinedDeliveryJobs = new Map([
  ["android-apk-release.yml", ["publish-android-apk"]],
  ["deploy-app.yml", ["deploy"]],
  ["deploy-relay.yml", ["deploy"]],
  ["deploy-website.yml", ["deploy"]],
  [
    "desktop-release.yml",
    ["create-release", "publish-macos", "publish-linux", "publish-windows", "finalize-rollout"],
  ],
  ["desktop-rollout.yml", ["stamp"]],
  ["docker.yml", ["publish"]],
  ["nix-update-hash.yml", ["update-hash"]],
  ["release-notes-sync.yml", ["sync-release-notes"]],
]);

function jobBlocks(source) {
  const jobs = new Map();
  let currentJob;

  for (const line of source.split("\n")) {
    const jobMatch = /^  ([a-z0-9-]+):\s*$/.exec(line);
    if (jobMatch) {
      currentJob = jobMatch[1];
      jobs.set(currentJob, []);
      continue;
    }
    if (currentJob) jobs.get(currentJob).push(line);
  }
  return jobs;
}

function loadFilters(path) {
  const filters = {};
  let currentFilter;

  for (const line of readFileSync(path, "utf8").split("\n")) {
    const filterMatch = /^([a-z_]+):\s*$/.exec(line);
    if (filterMatch) {
      currentFilter = filterMatch[1];
      filters[currentFilter] = [];
      continue;
    }
    const patternMatch = /^  - "([^"]+)"\s*$/.exec(line);
    if (currentFilter && patternMatch) filters[currentFilter].push(patternMatch[1]);
  }
  return filters;
}

function filesUnder(relativeDirectory, predicate) {
  const directory = new URL(`${relativeDirectory}/`, repoRoot);
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      [relativeDirectory, relativePath(directory.pathname, entry.parentPath), entry.name]
        .filter(Boolean)
        .join("/")
        .replaceAll("\\", "/"),
    )
    .filter(predicate)
    .sort();
}

test("gated checks are statically named jobs with real job-level gating", () => {
  const workflowSource = readFileSync(ciWorkflowPath, "utf8");
  const jobs = jobBlocks(workflowSource);
  const trigger = workflowSource.split("jobs:", 1)[0];

  assert.match(trigger, /^\s+merge_group:\s*$/m);
  assert.doesNotMatch(workflowSource, /strategy:\s*\n\s+matrix:/);
  assert.doesNotMatch(workflowSource, /RUN_TESTS|Skip unaffected|No .* changes detected/);

  for (const [jobId, expected] of gatedCiJobs) {
    const job = jobs.get(jobId)?.join("\n");
    assert.ok(job, `missing static job ${jobId}`);
    assert.match(job, new RegExp(`^    name: ${expected.name.replace(/[()]/g, "\\$&")}$`, "m"));
    assert.match(job, /needs\.changes\.outputs\.full != 'false'/);
    for (const contract of expected.contracts ?? [expected.contract]) {
      assert.match(job, new RegExp(`needs\\.changes\\.outputs\\.${contract} != 'false'`));
    }
  }
});

test("change gating allows superseded workflow runs to cancel", () => {
  for (const workflowPath of [ciWorkflowPath, dockerWorkflowPath, nixWorkflowPath]) {
    const source = readFileSync(workflowPath, "utf8");
    assert.doesNotMatch(
      source,
      /\$\{\{\s*always\(\)/,
      "always() keeps jobs alive after concurrency cancellation; use !cancelled() for fail-open gating",
    );
  }
});

test("mobile Operations, Visual, and Teams keep native device jobs off pull requests", () => {
  const source = readFileSync(mobileOperationsWorkflowPath, "utf8");
  const jobs = jobBlocks(source);
  const validation = jobs.get("validate")?.join("\n") ?? "";

  assert.match(validation, /bash -n scripts\/test-mobile-agent-device\.sh/);
  assert.match(validation, /bash -n scripts\/test-mobile-operations-agent-device\.sh/);
  assert.match(validation, /bash -n scripts\/run-mobile-operations-matrix\.sh/);
  assert.match(validation, /node --test scripts\/ci-workflow\.test\.mjs/);
  assert.doesNotMatch(validation, /setup-node|npm ci|expo|gradle|xcodebuild|agent-device test/);

  for (const jobId of ["ios", "android"]) {
    const job = jobs.get(jobId)?.join("\n") ?? "";
    assert.match(
      job,
      /^    if: github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'$/m,
    );
    assert.match(job, /^    needs: validate$/m);
  }
});

test("mobile Operations, Visual, and Teams stay isolated from the upstream runner", () => {
  const genericRunner = readFileSync(genericMobileRunnerPath, "utf8");
  const operationsRunner = readFileSync(operationsMobileRunnerPath, "utf8");
  const devClientFlow = readFileSync(nativeMatrixDevClientPath, "utf8");

  assert.doesNotMatch(
    genericRunner,
    /OPERATIONS_FIXTURE|PASEO_MOBILE_E2E_PLATFORM|operations-agent-device/,
  );
  assert.match(operationsRunner, /PASEO_MOBILE_E2E_OPERATIONS_FIXTURE:-1/);
  assert.match(operationsRunner, /PASEO_MOBILE_E2E_MATRIX_SURFACE:-operations/);
  assert.match(operationsRunner, /PASEO_MOBILE_E2E_PLATFORM/);
  assert.match(operationsRunner, /\$\{MATRIX_SURFACE\}-agent-device/);
  assert.match(operationsRunner, /\.dev\/operations-agent-device-e2e/);
  assert.match(operationsRunner, /\.dev\/operations-agent-device-artifacts/);
  assert.match(operationsRunner, /DEFAULT_METRO_PORT=8082/);
  assert.match(operationsRunner, /\.dev\/visual-agent-device-e2e/);
  assert.match(operationsRunner, /\.dev\/visual-agent-device-artifacts/);
  assert.match(operationsRunner, /DEFAULT_METRO_PORT=8083/);
  assert.match(operationsRunner, /\.dev\/teams-agent-device-e2e/);
  assert.match(operationsRunner, /\.dev\/teams-agent-device-artifacts/);
  assert.match(operationsRunner, /DEFAULT_METRO_PORT=8084/);
  assert.match(operationsRunner, /EXPO_PUBLIC_PASEO_E2E_DISABLE_PUSH_NOTIFICATIONS=1/);
  assert.match(operationsRunner, /EXPO_PUBLIC_PASEO_E2E_VISUAL_MOTION_PROBE=1/);
  assert.match(
    operationsRunner,
    /\[\[ "\$\{PLATFORM\}" == "ios" \]\][\s\S]*EXPO_PUBLIC_PASEO_E2E_FORCE_VISUAL_REDUCED_MOTION=1/,
  );
  assert.match(operationsRunner, /metro prepare[\s\S]*--no-reuse-existing/);
  assert.match(operationsRunner, /TARGET_ARGS\+=\(--serial "\$\{SERIAL\}"\)/);
  assert.match(operationsRunner, /replay[\s\S]*DEV_CLIENT_FLOW[\s\S]*--maestro/);
  assert.match(operationsRunner, /DEV_CLIENT_REPLAY_LOG/);
  assert.match(operationsRunner, /CAPTURE_AGENT_DEVICE_SESSIONS=1/);
  assert.match(operationsRunner, /agent-device-sessions/);
  assert.match(operationsRunner, /matchAll\(\/pass --session \(\\S\+\)/);
  assert.match(
    operationsRunner,
    /replay[\s\S]*DEV_CLIENT_FLOW[\s\S]*close --session "\$\{DEV_CLIENT_SESSION\}"[\s\S]*test/,
  );
  assert.match(devClientFlow, /clearState: true/);
  assert.match(devClientFlow, /openLink: \$\{DEV_CLIENT_URL\}/);
  assert.match(devClientFlow, /visible: "Open in\.\*Consolidated Compute/);
  assert.match(devClientFlow, /visible: "Continue"/);
  assert.match(devClientFlow, /visible: "Go home"/);
  assert.match(devClientFlow, /visible: "Runtime version:\.\*"/);
  assert.match(devClientFlow, /tapOn: "Close"/);
  assert.match(devClientFlow, /id: "menu-button"/);
});

test("mobile Operations replays keep one cross-platform contract", () => {
  const iosReplay = readFileSync(iosOperationsReplayPath, "utf8");
  const androidReplay = readFileSync(androidOperationsReplayPath, "utf8");
  const normalizePlatform = (source) =>
    source.replace(/^context platform=(ios|android)/, "context platform=native");

  assert.equal(normalizePlatform(iosReplay), normalizePlatform(androidReplay));
  assert.doesNotMatch(
    iosReplay,
    /settings (permission reset notifications|clear-app-state)|--launch-url|alert /,
  );
  assert.doesNotMatch(
    androidReplay,
    /settings (permission reset notifications|clear-app-state)|--launch-url|alert /,
  );
  assert.match(iosReplay, /wait "id=\\"menu-button\\"" 45000/);
  assert.match(iosReplay, /retries=0/);
  assert.match(iosReplay, /wait "id=\\"host-page-connections-card\\"" 30000/);
  assert.doesNotMatch(iosReplay, /retries=[1-9]/);
});

test("mobile Visual replays keep one cross-platform accessibility contract", () => {
  const iosReplay = readFileSync(iosVisualReplayPath, "utf8");
  const androidReplay = readFileSync(androidVisualReplayPath, "utf8");
  const normalizePlatform = (source) =>
    source
      .replace(/^context platform=(ios|android)/, "context platform=native")
      .replace(/^settings animations off\n/m, "");

  assert.equal(normalizePlatform(iosReplay), normalizePlatform(androidReplay));
  assert.doesNotMatch(
    iosReplay,
    /settings (permission reset notifications|clear-app-state)|--launch-url|alert /,
  );
  assert.doesNotMatch(
    androidReplay,
    /settings (permission reset notifications|clear-app-state)|--launch-url|alert /,
  );
  assert.match(iosReplay, /open "\$\{APP_ID\}" "paseo:\/\/visual" --relaunch/);
  assert.doesNotMatch(iosReplay, /settings animations off/);
  assert.match(androidReplay, /settings animations off/);
  assert.match(iosReplay, /orientation landscape-left/);
  assert.match(iosReplay, /orientation landscape-left[\s\S]*visual-viewport/);
  assert.doesNotMatch(
    iosReplay,
    /orientation landscape-left\nwait[^\n]+\nwait "id=\\"visual-layout-compact/,
  );
  assert.match(iosReplay, /wait "id=\\"visual-motion-reduced\\"" 30000/);
  assert.match(iosReplay, /wait "id=\\"host-page-connections-card\\"" 30000/);
  assert.doesNotMatch(iosReplay, /retries=[1-9]/);
  assert.match(iosReplay, /home\nopen "\$\{APP_ID\}"\nwait "id=\\"visual-screen/);
  assert.match(iosReplay, /get attrs "id=\\"visual-workspace-open-/);
  assert.match(iosReplay, /get attrs "id=\\"visual-agent-/);
  assert.match(iosReplay, /get attrs "id=\\"visual-provider-subagent-/);
  assert.match(iosReplay, /visual-dark-large-text-reduced-motion\.png/);
});

test("mobile Teams replays keep one cross-platform run contract", () => {
  const iosReplay = readFileSync(iosTeamsReplayPath, "utf8");
  const androidReplay = readFileSync(androidTeamsReplayPath, "utf8");
  const normalizePlatform = (source) =>
    source.replace(/^context platform=(ios|android)/, "context platform=native");

  assert.equal(normalizePlatform(iosReplay), normalizePlatform(androidReplay));
  assert.doesNotMatch(
    iosReplay,
    /settings (permission reset notifications|clear-app-state)|--launch-url|alert /,
  );
  assert.doesNotMatch(
    androidReplay,
    /settings (permission reset notifications|clear-app-state)|--launch-url|alert /,
  );
  assert.match(iosReplay, /team-detail-\$\{PRIMARY_SERVER_ID\}-\$\{PRIMARY_TEAM_ID\}/);
  assert.match(iosReplay, /retries=0/);
  assert.doesNotMatch(iosReplay, /retries=[1-9]/);
  assert.match(iosReplay, /orientation landscape-left/);
  assert.match(iosReplay, /home\nopen "\$\{APP_ID\}"/);
  assert.match(iosReplay, /team-run-role-status-\$\{PRIMARY_TEAM_ROLE_ID\}-ready/);
  assert.match(iosReplay, /team-run-status-waiting_for_permission/);
  assert.match(iosReplay, /permission-request-accept/);
  assert.match(iosReplay, /team-run-status-succeeded/);
});

test("mobile Operations, Visual, and Teams reuse native development apps", () => {
  const source = readFileSync(mobileOperationsWorkflowPath, "utf8");
  const matrixRunner = readFileSync(operationsMatrixRunnerPath, "utf8");

  assert.match(source, /actions\/cache\/restore@[a-f0-9]{40}/);
  assert.match(source, /actions\/cache\/save@[a-f0-9]{40}/);
  assert.match(source, /steps\.ios-app-cache\.outputs\.cache-hit != 'true'/);
  assert.match(source, /steps\.android-app-cache\.outputs\.cache-hit != 'true'/);
  assert.match(source, /simctl install.*mobile-build-cache\/ios/);
  assert.match(source, /adb install -r \.dev\/mobile-build-cache\/android\/app-debug\.apk/);
  assert.match(source, /-PreactNativeArchitectures=x86_64/);
  assert.match(source, /packages\/expo-two-way-audio\/ios\/\*\*/);
  assert.match(source, /packages\/expo-two-way-audio\/android\/\*\*/);
  assert.match(source, /bash scripts\/run-mobile-operations-matrix\.sh/);
  assert.match(matrixRunner, /npm run "test:e2e:mobile:\$\{surface\}"/);
  assert.match(matrixRunner, /run_surface operations/);
  assert.match(matrixRunner, /run_surface visual/);
  assert.match(matrixRunner, /run_surface teams/);
  assert.match(matrixRunner, /EVIDENCE_ROOT\}\/\$\{surface\}/);
  assert.doesNotMatch(source, /hashFiles\('\.github\/workflows\/mobile-operations\.yml'/);
});

test("mobile Operations, Visual, and Teams bound Android replay resources", () => {
  const source = readFileSync(mobileOperationsWorkflowPath, "utf8");
  const matrixRunner = readFileSync(operationsMatrixRunnerPath, "utf8");

  assert.match(source, /ram-size: 4096M/);
  assert.match(source, /heap-size: 512M/);
  assert.match(source, /PASEO_MOBILE_E2E_SERIAL: emulator-5554/);
  assert.match(
    source,
    /script: \|\n\s+adb install -r[^\n]+\n\s+bash scripts\/run-mobile-operations-matrix\.sh/,
  );
  assert.doesNotMatch(source, /NODE_OPTIONS=--max-old-space-size=2048 \\/);
  assert.equal(matrixRunner.match(/NODE_OPTIONS=--max-old-space-size=2048/g)?.length, 1);
});

test("fork delivery and write-back jobs stay quarantined", () => {
  for (const [workflowName, jobIds] of quarantinedDeliveryJobs) {
    const workflowPath = new URL(`.github/workflows/${workflowName}`, repoRoot);
    const jobs = jobBlocks(readFileSync(workflowPath, "utf8"));

    for (const jobId of jobIds) {
      const job = jobs.get(jobId);
      assert.ok(job, `${workflowName} is missing job ${jobId}`);
      const jobCondition = job.find((line) => line.startsWith("    if:"));
      assert.ok(jobCondition, `${workflowName}:${jobId} needs a job-level gate`);
      assert.match(
        jobCondition,
        /vars\.CC_DELIVERY_ENABLED == 'true'/,
        `${workflowName}:${jobId} job-level gate must fail closed without CC_DELIVERY_ENABLED=true`,
      );
    }
  }
});

test("upstream monitor stages stable releases without weakening review controls", () => {
  const source = readFileSync(upstreamReleaseMonitorPath, "utf8");

  assert.match(source, /^  schedule:\s*$/m);
  assert.match(source, /^    - cron: "17 13 \* \* \*"$/m);
  assert.match(source, /^  workflow_dispatch:\s*$/m);
  assert.match(source, /^  contents: read$/m);
  assert.match(source, /^  issues: write$/m);
  assert.match(source, /^  pull-requests: read$/m);
  assert.match(source, /^          ref: \$\{\{ github\.event\.repository\.default_branch \}\}$/m);
  assert.match(
    source,
    /^          DEFAULT_BRANCH: \$\{\{ github\.event\.repository\.default_branch \}\}$/m,
  );
  assert.match(source, /GITHUB_REF_NAME.*DEFAULT_BRANCH/);
  assert.match(source, /repos\/\$\{UPSTREAM_REPOSITORY\}\/releases\/latest/);
  assert.match(source, /\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/);
  assert.match(source, /git merge-base --is-ancestor/);
  assert.match(source, /gh api --method GET search\/issues/);
  assert.match(source, /gh issue create/);
  assert.match(source, /docs\/fork-maintenance\.md/);
  assert.doesNotMatch(source, /contents: write|pull-requests: write|git push|gh pr create/);
  assert.doesNotMatch(source, /--limit 100/);
  assert.doesNotMatch(source, /refs\/heads\/main|upstream\/main/);
});

test("focused contracts stay inside existing required checks", () => {
  const jobs = jobBlocks(readFileSync(ciWorkflowPath, "utf8"));
  const changes = jobs.get("changes")?.join("\n") ?? "";
  const server = jobs.get("server-tests-ubuntu")?.join("\n") ?? "";
  const desktop = jobs.get("desktop-tests-ubuntu")?.join("\n") ?? "";

  assert.match(changes, /scripts\/daemon-launch-contract\.test\.mjs/);
  assert.doesNotMatch(changes, /Install dependencies|npm run build/);

  assert.match(server, /test:hub-cli-contract/);
  assert.match(server, /npm run test --workspace=@getpaseo\/server/);
  assert.ok(!jobs.has("hub-cli-contract"));

  assert.match(desktop, /test:e2e:renderer/);
  assert.match(desktop, /test:e2e:browser-tabs/);
  assert.match(desktop, /npm run test --workspace=@getpaseo\/desktop/);
  assert.ok(!jobs.has("desktop-browser-bridge"));
  assert.ok(!jobs.has("playwright-desktop"));
});

test("server builds exclude test utilities at every domain depth", () => {
  const tsconfig = JSON.parse(readFileSync(serverTsconfigPath, "utf8"));
  assert.ok(tsconfig.exclude.includes("src/server/**/test-utils/**"));
  assert.ok(!tsconfig.exclude.includes("src/server/test-utils/**"));
});

test("PR routing declares stable behavior ownership", () => {
  const filters = loadFilters(filtersPath);
  assert.deepEqual(filters, {
    routing: [".github/ci-paths.yml"],
    workspace: [
      ".mise.toml",
      ".tool-versions",
      "package.json",
      "package-lock.json",
      "patches/**",
      "scripts/**",
      "tsconfig.json",
      "tsconfig.base.json",
      "vitest.config.ts",
    ],
    ci: [".github/actions/**", ".github/workflows/ci.yml"],
    format: [
      ".agents/**/*.{cjs,css,html,js,json,jsonc,jsx,md,mjs,ts,tsx,yaml,yml}",
      ".github/**/*.{cjs,css,html,js,json,jsonc,jsx,md,mjs,ts,tsx,yaml,yml}",
      "**/*.{cjs,css,html,js,json,jsonc,jsx,md,mjs,ts,tsx,yaml,yml}",
      "packages/expo-two-way-audio/**",
    ],
    quality: ["**/*.{cjs,js,json,jsx,mjs,ts,tsx}", "packages/expo-two-way-audio/**"],
    hub: ["packages/cli/src/commands/hub/**", "packages/server/src/server/hub/**"],
    server: ["packages/server/**", "packages/app/e2e/support/fixtures/recording.*"],
    desktop: [
      "packages/desktop/**",
      "packages/app/src/desktop/**",
      "packages/app/src/app/visual.tsx",
      "packages/app/src/operations/visual/**",
      "packages/server/src/server/browser-tools/**",
      "packages/app/e2e/support/**",
      "packages/app/*config.{cjs,js,ts}",
      "packages/app/package.json",
    ],
    app: ["packages/app/**", "packages/expo-two-way-audio/**"],
    sdk: ["packages/client/**", "packages/highlight/**", "packages/protocol/**"],
    browser: [
      "packages/app/src/!(desktop)/**",
      "packages/app/e2e/browser/**",
      "packages/app/e2e/support/**",
      "packages/app/assets/**",
      "packages/app/public/**",
      "packages/app/index.ts",
      "packages/app/*config.{cjs,js,ts}",
      "packages/app/package.json",
    ],
    relay: ["packages/relay/**"],
    cli: ["packages/cli/**"],
  });
});

test("cross-package invariants live in the suite that owns them", () => {
  const cliTests = filesUnder("packages/cli", (path) => path.endsWith(".test.ts"));
  assert.ok(cliTests.length > 0);
  for (const path of cliTests) {
    assert.doesNotMatch(
      readFileSync(new URL(path, repoRoot), "utf8"),
      /server\/src\/server\/test-utils/,
      path,
    );
  }

  const protocolWireCompatibility = new URL(
    "packages/protocol/src/messages.wire-compat.test.ts",
    repoRoot,
  );
  assert.match(readFileSync(protocolWireCompatibility, "utf8"), /wire schema compatibility/);
});

test("browser and desktop tests have exclusive, directory-owned suites", () => {
  const filters = loadFilters(filtersPath);
  const browserSpecs = filesUnder("packages/app/e2e", (path) => path.endsWith(".spec.ts"));
  const desktopSpecs = filesUnder("packages/desktop/e2e", (path) => path.endsWith(".spec.ts"));
  const electronModules = filesUnder("packages/app/src", (path) => /\.electron\.tsx?$/.test(path));

  assert.ok(browserSpecs.length > 0);
  assert.ok(desktopSpecs.length > 0);
  assert.ok(browserSpecs.every((path) => path.startsWith("packages/app/e2e/browser/")));
  assert.ok(desktopSpecs.every((path) => path.startsWith("packages/desktop/e2e/")));
  assert.ok(electronModules.every((path) => path.startsWith("packages/app/src/desktop/")));

  const desktopPackage = JSON.parse(readFileSync(desktopPackagePath, "utf8"));
  assert.match(desktopPackage.scripts.test, /--exclude ["']e2e\/\*\*["']/);

  for (const path of browserSpecs) {
    assert.doesNotMatch(
      readFileSync(new URL(path, repoRoot), "utf8"),
      /paseoDesktop|injectDesktopBridge/,
    );
  }
  for (const path of desktopSpecs) {
    assert.ok(path.startsWith("packages/desktop/e2e/"));
  }

  const routingSource = readFileSync(filtersPath, "utf8");
  assert.doesNotMatch(routingSource, /desktop_bridge|playwright_desktop|browser-\*|browser-\*\//);
  assert.deepEqual(filters.desktop, [
    "packages/desktop/**",
    "packages/app/src/desktop/**",
    "packages/app/src/app/visual.tsx",
    "packages/app/src/operations/visual/**",
    "packages/server/src/server/browser-tools/**",
    "packages/app/e2e/support/**",
    "packages/app/*config.{cjs,js,ts}",
    "packages/app/package.json",
  ]);
  assert.deepEqual(filters.browser, [
    "packages/app/src/!(desktop)/**",
    "packages/app/e2e/browser/**",
    "packages/app/e2e/support/**",
    "packages/app/assets/**",
    "packages/app/public/**",
    "packages/app/index.ts",
    "packages/app/*config.{cjs,js,ts}",
    "packages/app/package.json",
  ]);
});

test("non-required Docker and Nix workflows avoid runners with workflow path filters", () => {
  for (const workflowPath of [dockerWorkflowPath, nixWorkflowPath]) {
    const source = readFileSync(workflowPath, "utf8");
    const trigger = source.split("jobs:", 1)[0];
    assert.match(trigger, /^\s+paths:\s*$/m);
    assert.doesNotMatch(source, /dorny\/paths-filter/);
  }
});

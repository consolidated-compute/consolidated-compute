import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectDaemonClient } from "./daemon-client-loader";
import { startIsolatedHostDaemon, type IsolatedHostDaemon } from "./isolated-host-daemon";

// Keep proof traffic on the operator-selected Spark allowance; never fall back.
export const GITHUB_WORK_PROOF_MODEL = "gpt-5.3-codex-spark";
export const GITHUB_WORK_PROOF_FILE = "github-work-operator-checklist.md";
export const GITHUB_WORK_PROOF_OBJECTIVE =
  "Prove the local GitHub Work journey for CC issue #135. Produce a short operator checklist in github-work-operator-checklist.md, then test and review it. Do not commit, push, open a PR, merge, or change any other file.";

const PASSWORD = "shared-secret";
const PASSWORD_HASH = "$2b$12$GMhF7pN4QnMlHOQXOqjd1OitKWPSmAO3FwB0PHzKtcZR/sAMryz76";

export async function startGithubWorkProof() {
  const root = await mkdtemp(path.join(tmpdir(), "cc-github-work-proof-"));
  const paseoHome = path.join(root, "daemon");
  const checkout = path.join(root, "consolidated-compute");
  const serverId = "srv_github_work_proof";
  let daemon: IsolatedHostDaemon | null = null;
  let client: DaemonClient | null = null;
  const cleanup = async () => {
    try {
      await client?.close();
    } finally {
      try {
        await daemon?.close();
      } finally {
        await rm(root, { recursive: true, force: true, maxRetries: 5 });
      }
    }
  };
  try {
    await mkdir(paseoHome);
    await writeFile(
      path.join(paseoHome, "config.json"),
      JSON.stringify({ version: 1, daemon: { auth: { password: PASSWORD_HASH } } }),
    );
    daemon = await startIsolatedHostDaemon(serverId, {
      paseoHome,
      preserveHome: true,
      environment: {
        ...process.env,
        PASEO_PASSWORD: undefined,
        PASEO_E2E_GITHUB_WORK_FIXTURE: "0",
      },
    });
    client = await connectDaemonClient<DaemonClient>({
      clientIdPrefix: "github-work-proof",
      port: daemon.port,
      password: PASSWORD,
    });
    const connectedClient = client;
    return {
      serverId,
      port: daemon.port,
      password: PASSWORD,
      client: connectedClient,
      checkout,
      async prepareCheckout() {
        const source = path.resolve(__dirname, "../../../../..");
        const base = execFileSync("git", ["rev-parse", "origin/main"], {
          cwd: source,
          encoding: "utf8",
        }).trim();
        execFileSync("git", ["clone", "--shared", "--no-checkout", source, checkout], {
          stdio: "pipe",
        });
        execFileSync("git", ["checkout", "-b", "proof-base", base], {
          cwd: checkout,
          stdio: "pipe",
        });
        // This documentation-only proof needs no dependency install or native
        // build. Disable repository setup in this disposable clone's baseline,
        // leaving the source checkout and the daemon's worktree path untouched.
        const configPath = path.join(checkout, "paseo.json");
        const config = JSON.parse(await readFile(configPath, "utf8"));
        await writeFile(configPath, JSON.stringify({ ...config, worktree: { setup: [] } }));
        execFileSync("git", ["add", "paseo.json"], { cwd: checkout });
        execFileSync(
          "git",
          [
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "user.name=GitHub Work proof",
            "-c",
            "user.email=proof@example.invalid",
            "commit",
            "-m",
            "Configure disposable documentation proof worktree",
          ],
          { cwd: checkout, stdio: "pipe" },
        );
        execFileSync(
          "git",
          [
            "remote",
            "set-url",
            "origin",
            "https://github.com/consolidated-compute/consolidated-compute.git",
          ],
          { cwd: checkout },
        );
      },
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export async function saveGithubWorkProofTeam(client: DaemonClient, cwd: string) {
  const deadline = Date.now() + 60_000;
  let snapshot = await client.getProvidersSnapshot({ cwd });
  while (snapshot.entries.find((entry) => entry.provider === "codex")?.status === "loading") {
    if (Date.now() > deadline) throw new Error("Codex catalog did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 200));
    snapshot = await client.getProvidersSnapshot({ cwd });
  }
  const codex = snapshot.entries.find((entry) => entry.provider === "codex");
  if (codex?.status !== "ready") throw new Error("Codex catalog is unavailable");
  if (
    !codex.models?.some(
      (model) => model.id === GITHUB_WORK_PROOF_MODEL && model.isSelectable !== false,
    )
  ) {
    throw new Error(`Required proof model ${GITHUB_WORK_PROOF_MODEL} is unavailable; no fallback`);
  }
  const readOnly = codex.agentProfileSecurityPresets?.find(
    (preset) => preset.id === "fail-closed-read-only",
  );
  const writer = codex.agentProfileSecurityPresets?.find(
    (preset) => preset.id === "fail-closed-workspace-write",
  );
  if (!readOnly || !writer) throw new Error("Codex fail-closed security presets are unavailable");
  await client.patchDaemonConfig({
    agentProfiles: ["supervisor", "planner", "builder", "reviewer"].map((role) => ({
      id: `github-proof-${role}`,
      name: `GitHub proof ${role}`,
      provider: "codex",
      model: GITHUB_WORK_PROOF_MODEL,
      modeId: "auto",
      thinkingOptionId: "low",
      providerOptions: (role === "builder" ? writer : readOnly).providerOptions,
    })),
  });
  return client.createTeam({
    name: "GitHub Work proof",
    instructions:
      "Keep responses under 200 words. Work only on the requested checklist. No delegation, network, GitHub writes, commits, or merges.",
    roles: [
      {
        id: "supervisor",
        name: "Supervisor",
        profileId: "github-proof-supervisor",
        instructions:
          "Return plan with work_plan→plan, work_build→build, work_review→review in that order. Then dispatch the first planned item with all required accepted Artifact IDs. When all succeed, complete. Do not use tools, revise, or escalate. Use a new actionId per decision.",
      },
      {
        id: "planner",
        name: "Planner",
        profileId: "github-proof-planner",
        instructions:
          "Without tools, write a brief checklist outline for selecting a host, opening GitHub Work, selecting a repository and issue, creating an Assignment with an explicit objective, selecting a saved Team, creating a dedicated worktree, inspecting the security preview fingerprint, starting supervised execution, reviewing Artifacts and diff/tests, and leaving merge to a human. State that host gh authentication is needed and Hub is optional.",
      },
      {
        id: "builder",
        name: "Builder",
        profileId: "github-proof-builder",
        instructions: `Read the exact input plan Artifact. Write its operator checklist to ${GITHUB_WORK_PROOF_FILE} in this Workspace. Use these literal terms: GitHub Work, Assignment, worktree, security preview, Artifacts, gh, Hub, human. Do not read other repository files. Return the file path and a concise implementation summary.`,
      },
      {
        id: "reviewer",
        name: "Reviewer",
        profileId: "github-proof-reviewer",
        instructions: `Read the input Artifacts. Run node with a script that reads ${GITHUB_WORK_PROOF_FILE} and asserts it includes every string in ["GitHub Work","Assignment","worktree","security preview","Artifacts","gh","Hub","human"]. Inspect this file only. Report the actual test result and whether its steps match the plan. Do not modify files.`,
      },
    ],
    workflow: [
      { id: "plan", roleId: "planner", instructions: null },
      { id: "build", roleId: "builder", instructions: null },
      { id: "review", roleId: "reviewer", instructions: null },
    ],
  });
}

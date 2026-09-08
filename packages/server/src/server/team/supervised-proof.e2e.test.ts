import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentProfile } from "@getpaseo/protocol/messages";
import type { TeamRunDto, TeamSecurityFactDto } from "@getpaseo/protocol/team/types";
import { expect, test } from "vitest";

import type { AgentSessionConfig } from "../agent/agent-sdk-types.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { DaemonClient, createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/index.js";

const PASSWORD_HASH = "$2b$12$GMhF7pN4QnMlHOQXOqjd1OitKWPSmAO3FwB0PHzKtcZR/sAMryz76";
const PASSWORD = "shared-secret";

const readOnlyProviderOptions = {
  approval_policy: "never",
  sandbox_mode: "read-only",
  web_search: "disabled",
  features: { multi_agent_v2: false, network_proxy: false },
} as const;

const builderProviderOptions = {
  approval_policy: "on-request",
  sandbox_mode: "workspace-write",
  sandbox_workspace_write: {
    writable_roots: [],
    network_access: false,
    exclude_slash_tmp: true,
    exclude_tmpdir_env_var: true,
  },
  web_search: "disabled",
  features: { multi_agent_v2: false, network_proxy: false },
} as const;

interface ProofScenario {
  provider: "codex" | "claude";
  model: string;
  coordinatorModeId: string;
  coordinatorOptions: NonNullable<AgentProfile["providerOptions"]>;
  builderOptions: NonNullable<AgentProfile["providerOptions"]>;
  delegationEnabledOptions: NonNullable<AgentProfile["providerOptions"]>;
  coordinatorFilesystemStatus: TeamSecurityFactDto["status"];
  coordinatorToolStatus: TeamSecurityFactDto["status"];
}

// These catalogs and responses are deterministic adapters, not real-provider
// enforcement evidence. #127 still requires a separate real Claude run.
const scenarios: ProofScenario[] = [
  {
    provider: "codex",
    model: "gpt-5.4-mini",
    coordinatorModeId: "full-access",
    coordinatorOptions: readOnlyProviderOptions,
    builderOptions: builderProviderOptions,
    delegationEnabledOptions: {
      ...builderProviderOptions,
      features: { multi_agent_v2: true, network_proxy: false },
    },
    coordinatorFilesystemStatus: "enforced",
    coordinatorToolStatus: "unavailable",
  },
  {
    provider: "claude",
    model: "haiku",
    coordinatorModeId: "default",
    coordinatorOptions: { disallowedTools: ["Task", "Agent", "Workflow", "Write", "Edit", "Bash"] },
    builderOptions: { disallowedTools: ["Task", "Agent", "Workflow"] },
    delegationEnabledOptions: { disallowedTools: ["Task", "Agent"] },
    coordinatorFilesystemStatus: "unavailable",
    coordinatorToolStatus: "policy_only",
  },
];

function createProfiles(scenario: ProofScenario): AgentProfile[] {
  return [
    {
      id: "team-supervisor",
      name: "Team Supervisor",
      provider: scenario.provider,
      model: scenario.model,
      modeId: scenario.coordinatorModeId,
      providerOptions: scenario.coordinatorOptions,
    },
    {
      id: "architect",
      name: "Architect",
      provider: scenario.provider,
      model: scenario.model,
      modeId: scenario.coordinatorModeId,
      providerOptions: scenario.coordinatorOptions,
    },
    {
      id: "team-builder",
      name: "Team Builder",
      provider: scenario.provider,
      model: scenario.model,
      modeId: "default",
      featureValues: { test_feature: true },
      providerOptions: scenario.builderOptions,
    },
    {
      id: "security-review",
      name: "Security Review",
      provider: scenario.provider,
      model: scenario.model,
      modeId: scenario.coordinatorModeId,
      providerOptions: scenario.coordinatorOptions,
    },
  ];
}

function requireAcceptedOutput(prompt: string, workItemId: string): string {
  const escapedId = workItemId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^- ${escapedId}: [^\\n]*acceptedOutput=([^;\\n]+);`, "m").exec(prompt);
  const artifactId = match?.[1]?.trim();
  if (!artifactId || artifactId === "none") {
    const workLedger = prompt
      .split("\n")
      .filter((line) => line.includes("acceptedOutput="))
      .join(" | ");
    const retryDiagnostic = prompt.includes("Previous response was invalid")
      ? prompt.slice(prompt.indexOf("Previous response was invalid"))
      : "no retry diagnostic";
    throw new Error(
      `Supervisor prompt has no accepted output for ${workItemId}: ${workLedger}; ${retryDiagnostic}`,
    );
  }
  return artifactId;
}

function createProofAgentClients(scenario: ProofScenario) {
  const supervisorPrompts: string[] = [];
  const observedTurns: { config: AgentSessionConfig; prompt: string }[] = [];
  const resolveAssistantText = ({
    prompt,
    config,
  }: {
    prompt: string;
    config: Readonly<AgentSessionConfig>;
  }): string | undefined => {
    observedTurns.push({ config: structuredClone(config), prompt });
    if (prompt.includes("Revision parent attempt:")) return "REVISED_IMPLEMENT_ARTIFACT";
    if (!prompt.includes("## Decision rules") || !prompt.includes("TeamSupervisorAction")) {
      return undefined;
    }

    const turn = supervisorPrompts.push(prompt) - 1;
    switch (turn) {
      case 0:
        return JSON.stringify({
          kind: "plan",
          actionId: "action_plan",
          summary: "Plan, implement, and review the Assignment in order.",
          workItems: [
            { id: "work_plan", templateStepId: "plan" },
            { id: "work_implement", templateStepId: "implement" },
            { id: "work_review", templateStepId: "review" },
          ],
        });
      case 1:
        return JSON.stringify({
          kind: "dispatch",
          actionId: "action_dispatch_plan",
          summary: "Dispatch the frozen Planner.",
          workItemId: "work_plan",
          inputArtifactIds: [],
        });
      case 2:
        return JSON.stringify({
          kind: "dispatch",
          actionId: "action_dispatch_implement",
          summary: "Dispatch the Builder with the accepted plan.",
          workItemId: "work_implement",
          inputArtifactIds: [requireAcceptedOutput(prompt, "work_plan")],
        });
      case 3:
        return JSON.stringify({
          kind: "dispatch",
          actionId: "action_dispatch_review",
          summary: "Dispatch the Reviewer with all accepted predecessor outputs.",
          workItemId: "work_review",
          inputArtifactIds: [
            requireAcceptedOutput(prompt, "work_plan"),
            requireAcceptedOutput(prompt, "work_implement"),
          ],
        });
      case 4:
        return JSON.stringify({
          kind: "request_revision",
          actionId: "action_revise_implement",
          summary: "Revise the implementation using the Builder and Reviewer outputs.",
          workItemId: "work_implement",
          inputArtifactIds: [
            requireAcceptedOutput(prompt, "work_implement"),
            requireAcceptedOutput(prompt, "work_review"),
          ],
        });
      case 5:
        return JSON.stringify({
          kind: "escalate",
          actionId: "action_confirm_delivery",
          summary: "Confirm the revised and reviewed delivery before completion.",
          workItemId: null,
        });
      case 6:
        return JSON.stringify({
          kind: "complete",
          actionId: "action_complete",
          summary: "Complete the human-approved supervised delivery.",
        });
      default:
        throw new Error(`Unexpected supervisor turn ${turn + 1}`);
    }
  };

  return {
    agentClients: {
      [scenario.provider]: createTestAgentClient(scenario.provider, { resolveAssistantText }),
    },
    resolveAssistantText,
    supervisorPrompts,
    observedTurns,
  };
}

async function waitForRunStatus(
  client: DaemonClient,
  runId: string,
  status: TeamRunDto["state"]["status"],
): Promise<TeamRunDto> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const { run } = await client.getTeamRun(runId);
    if (run.state.status === status) return run;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const { run: finalRun } = await client.getTeamRun(runId);
  throw new Error(
    `Timed out waiting for Team Run ${runId} to reach ${status}; got ${finalRun.state.status}`,
  );
}

async function assistantTimelineText(client: DaemonClient, agentId: string): Promise<string> {
  const timeline = await client.fetchAgentTimeline(agentId, { limit: 100 });
  return timeline.entries
    .flatMap((entry) => (entry.item.type === "assistant_message" ? [entry.item.text] : []))
    .join("");
}

function requireCompletedAgentId(step: TeamRunDto["steps"][number]): string {
  if (!("agentId" in step.state) || step.state.agentId === null) {
    throw new Error(`Completed worker ${step.snapshot.stepId} has no agent`);
  }
  return step.state.agentId;
}

function requireOutputArtifactId(step: TeamRunDto["steps"][number]): string {
  const artifactId = step.snapshot.outputArtifact?.id;
  if (!artifactId) {
    throw new Error(`Completed worker ${step.snapshot.stepId} has no frozen Artifact ID`);
  }
  return artifactId;
}

async function admitProofRun(client: DaemonClient, cwd: string, scenario: ProofScenario) {
  expect(client.getLastServerInfoMessage()?.features).toMatchObject({
    assignments: true,
    teams: true,
    teamSupervision: true,
    teamSupervisionAdmission: "available",
  });
  const createdWorkspace = await client.createWorkspace({
    source: { kind: "directory", path: cwd },
  });
  if (!createdWorkspace.workspace) {
    throw new Error(createdWorkspace.error ?? "Failed to create supervised proof Workspace");
  }

  const { team } = await client.createTeam({
    name: "Supervised Delivery Team",
    instructions: "Use frozen roles and exact immutable Artifacts for every handoff.",
    roles: [
      {
        id: "supervisor",
        name: "Supervisor",
        instructions: "Coordinate bounded work and keep every decision durable.",
        profileId: "team-supervisor",
      },
      {
        id: "planner",
        name: "Planner",
        instructions: "Respond with exactly: PLAN_ARTIFACT",
        profileId: "architect",
      },
      {
        id: "builder",
        name: "Builder",
        instructions:
          'Create a file named "permission.txt" with the content "allowed". Respond with exactly: IMPLEMENT_ARTIFACT',
        profileId: "team-builder",
      },
      {
        id: "reviewer",
        name: "Reviewer",
        instructions: "Respond with exactly: REVIEW_ARTIFACT",
        profileId: "security-review",
      },
    ],
    workflow: [
      { id: "plan", roleId: "planner", instructions: null },
      { id: "implement", roleId: "builder", instructions: null },
      { id: "review", roleId: "reviewer", instructions: null },
    ],
  });
  const { assignment } = await client.createAssignment({
    title: "Supervised three-role proof",
    objective: "Produce, implement, review, revise, and approve a bounded delivery plan.",
    workItem: {
      sourceId: "github",
      sourceLabel: "GitHub",
      resourceType: "issue",
      resourceId: "consolidated-compute#127",
      identifier: "#127",
      title: "Validate a second harness through the Team contracts",
      url: "https://github.com/consolidated-compute/consolidated-compute/issues/127",
    },
  });
  const { preview } = await client.previewTeamRun({
    teamId: team.id,
    expectedRevision: team.revision,
    workspaceId: createdWorkspace.workspace.id,
  });
  const planner = preview.roles.find((role) => role.roleId === "planner");
  expect(planner?.resolvedLaunch).toMatchObject({
    provider: scenario.provider,
    model: scenario.model,
    securityPosture: {
      source: { provider: scenario.provider },
      filesystemWrite: { status: scenario.coordinatorFilesystemStatus },
      networkAccess: { status: "unavailable" },
      toolShell: { status: scenario.coordinatorToolStatus },
      nativeDelegation: { status: "enforced" },
    },
  });
  const admission = {
    teamId: team.id,
    expectedRevision: team.revision,
    idempotencyKey: "supervised-plan-implement-review",
    assignmentId: assignment.id,
    expectedAssignmentRevision: assignment.revision,
    workspaceId: createdWorkspace.workspace.id,
    supervision: { supervisorRoleId: "supervisor" },
    expectedPreviewFingerprint: preview.fingerprint,
  };
  const unsafeProfiles = createProfiles(scenario);
  const unsafeBuilder = unsafeProfiles.find((profile) => profile.id === "team-builder");
  if (!unsafeBuilder) throw new Error("Proof has no Builder profile");
  unsafeBuilder.providerOptions = scenario.delegationEnabledOptions;
  await client.patchDaemonConfig({ agentProfiles: unsafeProfiles });
  await expect(
    client.startAssignmentTeamRun({ ...admission, expectedPreviewFingerprint: undefined }),
  ).rejects.toThrow(/native delegation/i);
  await expect(client.listTeamRuns({ teamId: team.id })).resolves.toMatchObject({ runs: [] });
  await client.patchDaemonConfig({ agentProfiles: createProfiles(scenario) });
  const { run } = await client.startAssignmentTeamRun(admission);
  return { assignmentId: assignment.id, runId: run.id, admission, preview };
}

async function resolveBuilderPermission(client: DaemonClient, runId: string): Promise<void> {
  const permissionWait = await waitForRunStatus(client, runId, "waiting_for_permission");
  const permissionStep = permissionWait.steps.find(
    (step) => step.snapshot.roleId === "builder" && step.state.status === "waiting_for_permission",
  );
  if (!permissionStep || !("agentId" in permissionStep.state)) {
    throw new Error("Supervised Builder did not expose its permission-waiting agent");
  }
  const permissionState = await client.waitForFinish(permissionStep.state.agentId, 15_000);
  const permission = permissionState.final?.pendingPermissions?.[0];
  if (!permission) throw new Error("Supervised Builder has no pending provider permission");
  expect(permissionStep.snapshot.resolvedLaunch).toMatchObject({
    profileId: "team-builder",
    modeId: "default",
    featureValues: { test_feature: true },
  });
  // Remove every live profile while the Builder is blocked. The Reviewer,
  // revision attempt, and resumed supervisor must still use the admitted values.
  await client.patchDaemonConfig({ agentProfiles: [] });
  await client.respondToPermissionAndWait(permissionStep.state.agentId, permission.id, {
    behavior: "allow",
  });
}

async function expectCompletedProof(input: {
  client: DaemonClient;
  daemon: Awaited<ReturnType<typeof createTestPaseoDaemon>>;
  runId: string;
  assignmentId: string;
  supervisorPrompts: string[];
  scenario: ProofScenario;
  observedTurns: { config: AgentSessionConfig; prompt: string }[];
}): Promise<void> {
  const completed = await input.daemon.daemon.teamRunService.waitForRun(input.runId);
  if (completed.state.status !== "succeeded") {
    throw new Error(`Supervised proof failed: ${JSON.stringify(completed.state)}`);
  }
  expect(input.supervisorPrompts).toHaveLength(7);
  const persisted = await input.daemon.daemon.teamRepository.getRun(input.runId);
  if (!persisted?.supervision) throw new Error("Completed run lost supervised state");
  expect(persisted.supervision.decisions.map((decision) => decision.kind)).toEqual([
    "plan",
    "dispatch",
    "dispatch",
    "dispatch",
    "request_revision",
    "escalate",
    "complete",
  ]);
  expect(persisted.supervision.humanRequest?.resolution).toMatchObject({
    actionId: "continue",
    note: "Approved after reconnect and daemon restart.",
  });
  expect(persisted.supervision.supervisor.resolvedLaunch.providerOptions).toEqual(
    input.scenario.coordinatorOptions,
  );
  expect(
    persisted.supervision.workerTemplates.map(
      (template) => template.resolvedLaunch.providerOptions,
    ),
  ).toEqual([
    input.scenario.coordinatorOptions,
    input.scenario.builderOptions,
    input.scenario.coordinatorOptions,
  ]);

  const workerSteps = persisted.steps.filter(
    (step) => step.snapshot.supervision?.kind === "worker",
  );
  expect(workerSteps).toHaveLength(4);
  const [planStep, implementStep, reviewStep, revisionStep] = workerSteps;
  if (!planStep || !implementStep || !reviewStep || !revisionStep) {
    throw new Error("Completed supervised proof has incomplete worker history");
  }
  const planArtifactId = requireOutputArtifactId(planStep);
  const implementArtifactId = requireOutputArtifactId(implementStep);
  const reviewArtifactId = requireOutputArtifactId(reviewStep);
  const revisionArtifactId = requireOutputArtifactId(revisionStep);
  expect(workerSteps.map((step) => step.snapshot.inputArtifactIds)).toEqual([
    [],
    [planArtifactId],
    [planArtifactId, implementArtifactId],
    [implementArtifactId, reviewArtifactId],
  ]);
  expect(revisionStep.snapshot.supervision).toMatchObject({
    kind: "worker",
    workItemId: "work_implement",
    attemptNumber: 2,
    revisionParentAttemptId: implementStep.snapshot.supervision?.attemptId,
  });
  const builderWorkItem = persisted.supervision.workItems.find(
    (workItem) => workItem.id === "work_implement",
  );
  expect(builderWorkItem).toMatchObject({
    status: "succeeded",
    attemptIds: [
      implementStep.snapshot.supervision?.attemptId,
      revisionStep.snapshot.supervision?.attemptId,
    ],
    acceptedAttemptId: revisionStep.snapshot.supervision?.attemptId,
  });

  const { artifacts } = await input.client.listAssignmentArtifacts({
    assignmentId: input.assignmentId,
    limit: 100,
  });
  const artifactsById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  expect(artifacts).toHaveLength(4);
  expect(
    [planArtifactId, implementArtifactId, reviewArtifactId, revisionArtifactId].map(
      (artifactId) => artifactsById.get(artifactId)?.content,
    ),
  ).toEqual([
    "PLAN_ARTIFACT",
    "IMPLEMENT_ARTIFACT",
    "REVIEW_ARTIFACT",
    "REVISED_IMPLEMENT_ARTIFACT",
  ]);

  const workerTitles = new Set(
    ["Planner", "Builder", "Reviewer"].map((role) => `Supervised Delivery Team: ${role}`),
  );
  const workerTurns = input.observedTurns.filter((turn) =>
    workerTitles.has(turn.config.title ?? ""),
  );
  expect(workerTurns).toHaveLength(4);
  for (const [index, step] of workerSteps.entries()) {
    const turn = workerTurns[index];
    if (!turn || !step.snapshot.inputArtifactIds)
      throw new Error("Worker prompt or frozen inputs missing");
    const observedInputs = [
      ...turn.prompt.matchAll(
        /^### Artifact ([^\n]+)\n[\s\S]*?<untrusted-assignment-artifact>\n([\s\S]*?)\n<\/untrusted-assignment-artifact>/gm,
      ),
    ].map((match) => ({ id: match[1], content: match[2] }));
    const expectedInputs = step.snapshot.inputArtifactIds.map((id) => {
      const artifact = artifactsById.get(id);
      if (!artifact) throw new Error(`Frozen input Artifact ${id} is missing`);
      return { id, content: artifact.content };
    });
    expect(observedInputs).toEqual(expectedInputs);
  }

  const { events } = await input.client.listTeamRunSupervisionEvents({
    runId: input.runId,
    limit: 100,
  });
  const chronologicalEvents = events.toReversed();
  expect(chronologicalEvents.map((event) => event.sequence)).toEqual(
    Array.from({ length: chronologicalEvents.length }, (_, index) => index + 1),
  );
  expect(chronologicalEvents.map((event) => event.kind)).toEqual([
    "decision.plan",
    "decision.dispatch",
    "worker.succeeded",
    "decision.dispatch",
    "worker.succeeded",
    "decision.dispatch",
    "worker.succeeded",
    "decision.request_revision",
    "worker.succeeded",
    "decision.escalate",
    "human_request.resolved",
    "decision.complete",
  ]);
  expect(
    chronologicalEvents.find((event) => event.kind === "decision.request_revision"),
  ).toMatchObject({
    workItemId: "work_implement",
    artifactIds: [implementArtifactId, reviewArtifactId, revisionArtifactId],
  });

  const workerAgentIds = workerSteps.map(requireCompletedAgentId);
  expect(
    await Promise.all(
      workerAgentIds.map((agentId) => assistantTimelineText(input.client, agentId)),
    ),
  ).toEqual([
    "PLAN_ARTIFACT",
    "IMPLEMENT_ARTIFACT",
    "REVIEW_ARTIFACT",
    "REVISED_IMPLEMENT_ARTIFACT",
  ]);
}

test.each(scenarios)(
  "retains $provider supervised contracts through restart with a deterministic provider",
  async (scenario) => {
    const temporaryDirectories: string[] = [];
    let daemon: TestPaseoDaemon | null = null;
    let client: DaemonClient | null = null;
    try {
      const paseoHomeRoot = await trackedTemporaryDirectory(
        temporaryDirectories,
        "paseo-supervised-proof-home-",
      );
      const staticDir = await trackedTemporaryDirectory(
        temporaryDirectories,
        "paseo-supervised-proof-static-",
      );
      const cwd = await trackedTemporaryDirectory(
        temporaryDirectories,
        "paseo-supervised-proof-workspace-",
      );
      const proof = createProofAgentClients(scenario);
      daemon = await createTestPaseoDaemon({
        paseoHomeRoot,
        staticDir,
        cleanup: false,
        agentClients: proof.agentClients,
        agentProfiles: [],
        auth: { password: PASSWORD_HASH },
      });
      client = new DaemonClient({
        url: `ws://127.0.0.1:${daemon.port}/ws`,
        password: PASSWORD,
      });
      await client.connect();
      await client.patchDaemonConfig({ agentProfiles: createProfiles(scenario) });
      const proofRun = await admitProofRun(client, cwd, scenario);
      await resolveBuilderPermission(client, proofRun.runId);

      const waiting = await daemon.daemon.teamRunService.waitForRun(proofRun.runId);
      expect(waiting).toMatchObject({
        state: { status: "running" },
        supervision: {
          phase: "awaiting_human",
          humanRequest: {
            detail: "Confirm the revised and reviewed delivery before completion.",
            actions: [{ id: "continue" }, { id: "cancel" }],
          },
        },
      });
      expect(proof.supervisorPrompts).toHaveLength(6);

      await client.close();
      client = new DaemonClient({
        url: `ws://127.0.0.1:${daemon.port}/ws`,
        password: PASSWORD,
      });
      await client.connect();
      await expect(client.getTeamRunSupervision(proofRun.runId)).resolves.toMatchObject({
        supervision: { status: "awaiting_human" },
      });

      await client.close();
      await daemon.close();
      daemon = await createTestPaseoDaemon({
        paseoHomeRoot,
        staticDir,
        cleanup: false,
        agentClients: {
          [scenario.provider]: createTestAgentClient(scenario.provider, {
            resolveAssistantText: proof.resolveAssistantText,
          }),
        },
        agentProfiles: [],
        auth: { password: PASSWORD_HASH },
      });
      client = new DaemonClient({
        url: `ws://127.0.0.1:${daemon.port}/ws`,
        password: PASSWORD,
      });
      await client.connect();
      const { supervision: restartedState } = await client.getTeamRunSupervision(proofRun.runId);
      expect(restartedState).toMatchObject({
        status: "awaiting_human",
        humanRequest: { detail: "Confirm the revised and reviewed delivery before completion." },
      });
      expect(restartedState.humanRequest).not.toHaveProperty("resolution");
      expect(proof.supervisorPrompts).toHaveLength(6);
      const humanRequest = restartedState.humanRequest;
      if (!humanRequest) throw new Error("Restarted supervised run lost its human request");
      await client.respondToTeamRunSupervisionHumanRequest({
        runId: proofRun.runId,
        humanRequestId: humanRequest.id,
        expectedRevision: humanRequest.revision,
        actionId: "continue",
        note: "Approved after reconnect and daemon restart.",
        idempotencyKey: "approve-supervised-plan-implement-review",
      });

      await expectCompletedProof({
        client,
        daemon,
        runId: proofRun.runId,
        assignmentId: proofRun.assignmentId,
        supervisorPrompts: proof.supervisorPrompts,
        scenario,
        observedTurns: proof.observedTurns,
      });

      const { run: completed } = await client.getTeamRun(proofRun.runId);
      for (const step of completed.steps.filter(
        (candidate) => candidate.snapshot.supervision?.kind === "worker",
      )) {
        const previewRole = proofRun.preview.roles.find(
          (role) => role.roleId === step.snapshot.roleId,
        );
        if (!previewRole) throw new Error(`Preview lost role ${step.snapshot.roleId}`);
        expect(step.snapshot.resolvedLaunch).toEqual(previewRole.resolvedLaunch);
      }
      // Inspect actual prompt-boundary configs, including the supervisor reloaded
      // after restart. This proves daemon propagation, not SDK enforcement.
      const supervisorTurns = proof.observedTurns.filter((turn) =>
        turn.prompt.includes("## Decision rules"),
      );
      expect(supervisorTurns).toHaveLength(7);
      for (const turn of supervisorTurns) {
        expect(turn.config).toMatchObject({
          provider: scenario.provider,
          model: scenario.model,
        });
        expect(turn.config.providerOptions).toEqual(scenario.coordinatorOptions);
      }
      const reviewerTurn = proof.observedTurns.find(
        (turn) => turn.config.title === "Supervised Delivery Team: Reviewer",
      );
      expect(reviewerTurn?.config).toMatchObject({
        provider: scenario.provider,
        model: scenario.model,
      });
      expect(reviewerTurn?.config.providerOptions).toEqual(scenario.coordinatorOptions);
      const builderTurns = proof.observedTurns.filter(
        (turn) => turn.config.title === "Supervised Delivery Team: Builder",
      );
      expect(builderTurns).toHaveLength(2);
      for (const turn of builderTurns) {
        expect(turn.config).toMatchObject({
          provider: scenario.provider,
          model: scenario.model,
        });
        expect(turn.config.providerOptions).toEqual(scenario.builderOptions);
      }
      await expect(
        client.startAssignmentTeamRun({
          ...proofRun.admission,
          idempotencyKey: "removed-profiles-block-future-run",
        }),
      ).rejects.toThrow(/profile/i);
      const { run: retried } = await client.startAssignmentTeamRun(proofRun.admission);
      expect(retried).toEqual(completed);
      expect((await client.getTeamRun(proofRun.runId)).run).toEqual(completed);
    } finally {
      try {
        await client?.close();
      } finally {
        try {
          await daemon?.close();
        } finally {
          await Promise.all(
            temporaryDirectories.map((directory) =>
              rm(directory, { recursive: true, force: true }),
            ),
          );
        }
      }
    }
  },
  30_000,
);

async function trackedTemporaryDirectory(directories: string[], prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

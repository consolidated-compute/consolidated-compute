import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentProfile } from "@getpaseo/protocol/messages";
import type { TeamRunDto } from "@getpaseo/protocol/team/types";
import { expect, test } from "vitest";

import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { DaemonClient, createTestPaseoDaemon } from "../test-utils/index.js";

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

const profiles = [
  {
    id: "team-supervisor",
    name: "Team Supervisor",
    provider: "codex",
    model: "gpt-5.4-mini",
    modeId: "full-access",
    providerOptions: readOnlyProviderOptions,
  },
  {
    id: "architect",
    name: "Architect",
    provider: "codex",
    model: "gpt-5.4-mini",
    modeId: "full-access",
    providerOptions: readOnlyProviderOptions,
  },
  {
    id: "codex-builder",
    name: "Codex Builder",
    provider: "codex",
    model: "gpt-5.4-mini",
    modeId: "default",
    featureValues: { test_feature: true },
    providerOptions: builderProviderOptions,
  },
  {
    id: "security-review",
    name: "Security Review",
    provider: "codex",
    model: "gpt-5.4-mini",
    modeId: "full-access",
    providerOptions: readOnlyProviderOptions,
  },
] satisfies AgentProfile[];

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

function createProofAgentClients() {
  const supervisorPrompts: string[] = [];
  const resolveAssistantText = ({ prompt }: { prompt: string }): string | undefined => {
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
    agentClients: createTestAgentClients({ resolveAssistantText }),
    resolveAssistantText,
    supervisorPrompts,
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

async function admitProofRun(client: DaemonClient, cwd: string) {
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
        profileId: "codex-builder",
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
      resourceId: "consolidated-compute#96",
      identifier: "#96",
      title: "Prove a real supervised Plan to Implement to Review Team",
      url: "https://github.com/consolidated-compute/consolidated-compute/issues/96",
    },
  });
  const { run } = await client.startAssignmentTeamRun({
    teamId: team.id,
    expectedRevision: team.revision,
    idempotencyKey: "supervised-plan-implement-review",
    assignmentId: assignment.id,
    expectedAssignmentRevision: assignment.revision,
    workspaceId: createdWorkspace.workspace.id,
    supervision: { supervisorRoleId: "supervisor" },
  });
  return { assignmentId: assignment.id, runId: run.id };
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
    profileId: "codex-builder",
    modeId: "default",
    featureValues: { test_feature: true },
  });
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
    readOnlyProviderOptions,
  );
  expect(
    persisted.supervision.workerTemplates.map(
      (template) => template.resolvedLaunch.providerOptions,
    ),
  ).toEqual([readOnlyProviderOptions, builderProviderOptions, readOnlyProviderOptions]);

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

test("proves a supervised Plan to Implement to Review Team through restart", async () => {
  const paseoHomeRoot = await mkdtemp(join(tmpdir(), "paseo-supervised-proof-home-"));
  const staticDir = await mkdtemp(join(tmpdir(), "paseo-supervised-proof-static-"));
  const cwd = await mkdtemp(join(tmpdir(), "paseo-supervised-proof-workspace-"));
  const proof = createProofAgentClients();
  let daemon = await createTestPaseoDaemon({
    paseoHomeRoot,
    staticDir,
    cleanup: false,
    agentClients: proof.agentClients,
    agentProfiles: profiles,
    auth: { password: PASSWORD_HASH },
  });
  let client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    password: PASSWORD,
  });

  try {
    await client.connect();
    const proofRun = await admitProofRun(client, cwd);
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
      agentClients: createTestAgentClients({
        resolveAssistantText: proof.resolveAssistantText,
      }),
      agentProfiles: profiles,
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
    });
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
    await Promise.all([
      rm(paseoHomeRoot, { recursive: true, force: true }),
      rm(staticDir, { recursive: true, force: true }),
      rm(cwd, { recursive: true, force: true }),
    ]);
  }
}, 30_000);

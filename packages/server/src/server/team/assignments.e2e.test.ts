import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentProfile } from "@getpaseo/protocol/messages";
import type { TeamRunDto } from "@getpaseo/protocol/team/types";
import { expect, test } from "vitest";

import type { AgentPromptInput } from "../agent/agent-sdk-types.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { DaemonClient, createTestPaseoDaemon } from "../test-utils/index.js";

const profiles = [
  {
    id: "architect",
    name: "Architect",
    provider: "codex",
    model: "gpt-5.4-mini",
    modeId: "full-access",
  },
  {
    id: "codex-builder",
    name: "Codex Builder",
    provider: "codex",
    model: "gpt-5.4-mini",
    modeId: "full-access",
    featureValues: { test_feature: true },
  },
  {
    id: "security-review",
    name: "Security Review",
    provider: "claude",
    model: "sonnet",
    modeId: "full-access",
  },
] satisfies AgentProfile[];

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
  const { run } = await client.getTeamRun(runId);
  throw new Error(
    `Timed out waiting for Team Run ${runId} to reach ${status}; got ${run.state.status}`,
  );
}

async function assistantTimelineText(client: DaemonClient, agentId: string): Promise<string> {
  const timeline = await client.fetchAgentTimeline(agentId, { limit: 100 });
  return timeline.entries
    .flatMap((entry) => (entry.item.type === "assistant_message" ? [entry.item.text] : []))
    .join("");
}

test("freezes a three-role Assignment run and hands forward only declared Artifacts", async () => {
  const prompts: AgentPromptInput[] = [];
  const paseoHomeRoot = await mkdtemp(join(tmpdir(), "paseo-assignment-contract-home-"));
  const staticDir = await mkdtemp(join(tmpdir(), "paseo-assignment-contract-static-"));
  const cwd = await mkdtemp(join(tmpdir(), "paseo-assignment-contract-workspace-"));
  const agentClients = createTestAgentClients({
    onStartTurn: (prompt) => prompts.push(prompt),
  });
  let daemon = await createTestPaseoDaemon({
    paseoHomeRoot,
    staticDir,
    cleanup: false,
    agentClients,
    agentProfiles: profiles,
  });
  let client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.6.0",
  });

  try {
    await client.connect();
    expect(client.getLastServerInfoMessage()?.features).toMatchObject({
      agentProfiles: true,
      assignments: true,
      teams: true,
    });
    const createdWorkspace = await client.createWorkspace({
      source: { kind: "directory", path: cwd },
    });
    if (!createdWorkspace.workspace) {
      throw new Error(createdWorkspace.error ?? "Failed to create Assignment test Workspace");
    }

    const { team } = await client.createTeam({
      name: "Artifact Delivery Team",
      instructions: "Use only the frozen Assignment objective and declared input Artifacts.",
      roles: [
        {
          id: "planner",
          name: "Planner",
          instructions: "Respond with exactly: PLAN_ARTIFACT",
          profileId: "architect",
        },
        {
          id: "builder",
          name: "Builder",
          instructions: "Respond with exactly: IMPLEMENT_ARTIFACT",
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
    const originalObjective = "Prove exact Plan to Implement to Review Artifact handoffs.";
    const workItemBodySentinel = "UNTRUSTED_WORK_ITEM_BODY_MUST_NOT_APPEAR";
    const { assignment } = await client.createAssignment({
      title: "Three-role Artifact contract",
      objective: originalObjective,
      workItem: {
        sourceId: "github",
        sourceLabel: "GitHub",
        resourceType: "issue",
        resourceId: "consolidated-compute#72",
        identifier: "#72",
        title: "Assignments: prove the three-role Artifact contract",
        url: "https://github.com/consolidated-compute/consolidated-compute/issues/72",
      },
    });
    const admission = {
      teamId: team.id,
      expectedRevision: team.revision,
      idempotencyKey: "assignment-plan-implement-review",
      assignmentId: assignment.id,
      expectedAssignmentRevision: assignment.revision,
      workspaceId: createdWorkspace.workspace.id,
    };

    const { run: started } = await client.startAssignmentTeamRun(admission);
    await daemon.daemon.teamRunService.waitForRun(started.id);
    const { run: completed } = await client.getTeamRun(started.id);
    const { artifacts } = await client.listAssignmentArtifacts({
      assignmentId: assignment.id,
      limit: 100,
    });

    expect(completed.state.status).toBe("succeeded");
    expect(completed).toMatchObject({
      teamRevision: team.revision,
      teamSnapshot: team,
      objective: originalObjective,
      assignmentId: assignment.id,
      assignmentRevision: assignment.revision,
      assignmentSnapshot: assignment,
    });
    expect(completed.steps.map((step) => step.snapshot.resolvedLaunch)).toEqual([
      {
        profileId: "architect",
        provider: "codex",
        model: "gpt-5.4-mini",
        modeId: "full-access",
        thinkingOptionId: null,
        featureValues: {},
      },
      {
        profileId: "codex-builder",
        provider: "codex",
        model: "gpt-5.4-mini",
        modeId: "full-access",
        thinkingOptionId: null,
        featureValues: { test_feature: true },
      },
      {
        profileId: "security-review",
        provider: "claude",
        model: "sonnet",
        modeId: "full-access",
        thinkingOptionId: null,
        featureValues: {},
      },
    ]);

    const artifactsByStep = new Map(
      artifacts.map((artifact) => [artifact.producer.stepId, artifact]),
    );
    const planArtifact = artifactsByStep.get("plan");
    const implementArtifact = artifactsByStep.get("implement");
    const reviewArtifact = artifactsByStep.get("review");
    if (!planArtifact || !implementArtifact || !reviewArtifact) {
      throw new Error("Expected one durable Artifact for every Team step");
    }
    expect(artifacts).toHaveLength(3);
    expect([planArtifact.content, implementArtifact.content, reviewArtifact.content]).toEqual([
      "PLAN_ARTIFACT",
      "IMPLEMENT_ARTIFACT",
      "REVIEW_ARTIFACT",
    ]);
    expect(completed.steps.map((step) => step.snapshot.inputArtifactIds)).toEqual([
      [],
      [planArtifact.id],
      [implementArtifact.id],
    ]);
    expect(completed.steps.map((step) => step.snapshot.outputArtifact?.id)).toEqual([
      planArtifact.id,
      implementArtifact.id,
      reviewArtifact.id,
    ]);
    for (const [index, artifact] of [planArtifact, implementArtifact, reviewArtifact].entries()) {
      const step = completed.steps[index];
      if (!step || !("agentId" in step.state) || step.state.agentId === null) {
        throw new Error(`Completed Team step ${index} has no producer agent`);
      }
      expect(artifact).toMatchObject({
        assignmentId: assignment.id,
        assignmentRevision: assignment.revision,
        kind: "team_step_output",
        title: `${step.snapshot.roleName} output`,
        mediaType: "text/markdown",
        includedBytes: Buffer.byteLength(artifact.content, "utf8"),
        originalBytes: Buffer.byteLength(artifact.content, "utf8"),
        truncated: false,
        producer: {
          kind: "team_run_step",
          teamRunId: completed.id,
          stepId: step.snapshot.stepId,
          roleId: step.snapshot.roleId,
          agentId: step.state.agentId,
          turnId: "fake-turn-0",
        },
      });
    }

    expect(prompts).toHaveLength(3);
    expect(prompts.every((prompt) => typeof prompt === "string")).toBe(true);
    const [planPrompt, implementPrompt, reviewPrompt] = prompts as string[];
    for (const prompt of [planPrompt, implementPrompt, reviewPrompt]) {
      expect(prompt).toContain(`## Objective\n${originalObjective}`);
      expect(prompt).not.toContain("Previous step final response");
      expect(prompt).not.toContain(workItemBodySentinel);
    }
    expect(planPrompt).not.toContain("## Input Artifacts");
    expect(implementPrompt).toContain(`ID: ${planArtifact.id}`);
    expect(implementPrompt).toContain("<untrusted-assignment-artifact>\nPLAN_ARTIFACT");
    expect(implementPrompt).not.toContain(implementArtifact.id);
    expect(implementPrompt).not.toContain("REVIEW_ARTIFACT");
    expect(reviewPrompt).toContain(`ID: ${implementArtifact.id}`);
    expect(reviewPrompt).toContain("<untrusted-assignment-artifact>\nIMPLEMENT_ARTIFACT");
    expect(reviewPrompt).not.toContain(planArtifact.id);
    expect(reviewPrompt).not.toContain("PLAN_ARTIFACT");

    const producerAgentIds = completed.steps.map((step) => {
      if (!("agentId" in step.state) || step.state.agentId === null) {
        throw new Error(`Completed Team step ${step.snapshot.stepId} has no producer agent`);
      }
      return step.state.agentId;
    });
    expect(
      await Promise.all(producerAgentIds.map((agentId) => assistantTimelineText(client, agentId))),
    ).toEqual(["PLAN_ARTIFACT", "IMPLEMENT_ARTIFACT", "REVIEW_ARTIFACT"]);

    const { team: editedTeam } = await client.updateTeam({
      teamId: team.id,
      expectedRevision: team.revision,
      patch: { name: "Edited after the frozen run" },
    });
    const { assignment: editedAssignment } = await client.patchAssignment({
      assignmentId: assignment.id,
      expectedRevision: assignment.revision,
      patch: { objective: "Changed after the frozen run." },
    });
    await client.patchDaemonConfig({ agentProfiles: [] });
    await expect(
      client.startAssignmentTeamRun({
        ...admission,
        expectedRevision: editedTeam.revision,
        expectedAssignmentRevision: editedAssignment.revision,
        idempotencyKey: "missing-profiles-fail-explicitly",
      }),
    ).rejects.toThrow(/profile/i);
    const { run: unchangedAfterEdits } = await client.getTeamRun(completed.id);
    expect(unchangedAfterEdits).toEqual(completed);

    const { run: idempotentRetry } = await client.startAssignmentTeamRun(admission);
    expect(idempotentRetry).toEqual(completed);
    expect(prompts).toHaveLength(3);

    await client.close();
    await daemon.close();
    daemon = await createTestPaseoDaemon({
      paseoHomeRoot,
      staticDir,
      cleanup: false,
      agentClients,
      agentProfiles: [],
    });
    client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.6.0",
    });
    await client.connect();

    const { run: reloadedRun } = await client.getTeamRun(completed.id);
    const { artifacts: reloadedArtifacts } = await client.listAssignmentArtifacts({
      assignmentId: assignment.id,
      limit: 100,
    });
    expect(reloadedRun).toEqual(completed);
    expect(reloadedArtifacts).toEqual(artifacts);
    expect(
      await Promise.all(producerAgentIds.map((agentId) => assistantTimelineText(client, agentId))),
    ).toEqual(["PLAN_ARTIFACT", "IMPLEMENT_ARTIFACT", "REVIEW_ARTIFACT"]);
    expect(prompts).toHaveLength(3);
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
    await Promise.all(
      [paseoHomeRoot, staticDir, cwd].map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  }
}, 180_000);

test("retains durable output across later failure, permission resume, and cancellation", async () => {
  const prompts: AgentPromptInput[] = [];
  const cwd = await mkdtemp(join(tmpdir(), "paseo-assignment-lifecycle-workspace-"));
  const daemon = await createTestPaseoDaemon({
    agentClients: createTestAgentClients({
      onStartTurn: (prompt) => prompts.push(prompt),
    }),
    agentProfiles: [
      ...profiles,
      {
        id: "approval-builder",
        name: "Approval Builder",
        provider: "codex",
        model: "gpt-5.4-mini",
        modeId: "default",
      },
    ],
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.6.0",
  });

  try {
    await client.connect();
    const createdWorkspace = await client.createWorkspace({
      source: { kind: "directory", path: cwd },
    });
    if (!createdWorkspace.workspace) {
      throw new Error(createdWorkspace.error ?? "Failed to create Assignment test Workspace");
    }
    const workspaceId = createdWorkspace.workspace.id;

    const { team: failingTeam } = await client.createTeam({
      name: "Later Failure Team",
      instructions: "Retain durable predecessor output if a later role fails.",
      roles: [
        {
          id: "planner",
          name: "Planner",
          instructions: "Respond with exactly: RETAINED_PLAN",
          profileId: "architect",
        },
        {
          id: "builder",
          name: "Builder",
          instructions: "Emit a turn failure",
          profileId: "codex-builder",
        },
        {
          id: "reviewer",
          name: "Reviewer",
          instructions: "Respond with exactly: MUST_NOT_RUN",
          profileId: "security-review",
        },
      ],
      workflow: [
        { id: "plan", roleId: "planner", instructions: null },
        { id: "implement", roleId: "builder", instructions: null },
        { id: "review", roleId: "reviewer", instructions: null },
      ],
    });
    const { assignment: failedAssignment } = await client.createAssignment({
      title: "Retain output after failure",
      objective: "Keep the Plan Artifact when Implement fails.",
      workItem: null,
    });
    const promptsBeforeFailure = prompts.length;
    const { run: failingRun } = await client.startAssignmentTeamRun({
      teamId: failingTeam.id,
      expectedRevision: failingTeam.revision,
      idempotencyKey: "assignment-later-failure",
      assignmentId: failedAssignment.id,
      expectedAssignmentRevision: failedAssignment.revision,
      workspaceId,
    });
    const failedRun = await daemon.daemon.teamRunService.waitForRun(failingRun.id);
    const failedArtifacts = await client.listAssignmentArtifacts({
      assignmentId: failedAssignment.id,
      limit: 100,
    });
    expect(failedRun.state.status).toBe("failed");
    expect(failedRun.steps.map((step) => step.state.status)).toEqual([
      "succeeded",
      "failed",
      "pending",
    ]);
    expect(failedArtifacts.artifacts).toHaveLength(1);
    expect(failedArtifacts.artifacts[0]).toMatchObject({
      id: failedRun.steps[0]?.snapshot.outputArtifact?.id,
      content: "RETAINED_PLAN",
      producer: {
        teamRunId: failedRun.id,
        stepId: "plan",
        roleId: "planner",
      },
    });
    expect(prompts.slice(promptsBeforeFailure)).toHaveLength(2);

    const { team: approvalTeam } = await client.createTeam({
      name: "Permission Team",
      instructions: "Exercise the run permission boundary.",
      roles: [
        {
          id: "operator",
          name: "Operator",
          instructions:
            'Create a file named "permission.txt" with the content "allowed". Respond with exactly: PERMISSION_ARTIFACT',
          profileId: "approval-builder",
        },
      ],
      workflow: [{ id: "operate", roleId: "operator", instructions: null }],
    });
    const { assignment: resumedAssignment } = await client.createAssignment({
      title: "Resume permission",
      objective: "Wait for approval, then persist the output Artifact.",
      workItem: null,
    });
    const { run: resumableRun } = await client.startAssignmentTeamRun({
      teamId: approvalTeam.id,
      expectedRevision: approvalTeam.revision,
      idempotencyKey: "assignment-permission-resume",
      assignmentId: resumedAssignment.id,
      expectedAssignmentRevision: resumedAssignment.revision,
      workspaceId,
    });
    const waitingRun = await waitForRunStatus(client, resumableRun.id, "waiting_for_permission");
    const waitingStep = waitingRun.steps[0];
    if (!waitingStep || !("agentId" in waitingStep.state) || waitingStep.state.agentId === null) {
      throw new Error("Permission-waiting Team step has no agent");
    }
    const permissionState = await client.waitForFinish(waitingStep.state.agentId, 15_000);
    const permission = permissionState.final?.pendingPermissions?.[0];
    if (!permission) throw new Error("Permission-waiting agent has no pending permission");
    await client.respondToPermissionAndWait(waitingStep.state.agentId, permission.id, {
      behavior: "allow",
    });
    const resumedRun = await daemon.daemon.teamRunService.waitForRun(resumableRun.id);
    const resumedArtifacts = await client.listAssignmentArtifacts({
      assignmentId: resumedAssignment.id,
      limit: 100,
    });
    expect(resumedRun.state.status).toBe("succeeded");
    expect(resumedArtifacts.artifacts).toMatchObject([
      {
        id: resumedRun.steps[0]?.snapshot.outputArtifact?.id,
        content: "PERMISSION_ARTIFACT",
        producer: { teamRunId: resumedRun.id, stepId: "operate", roleId: "operator" },
      },
    ]);

    const { assignment: canceledAssignment } = await client.createAssignment({
      title: "Cancel permission wait",
      objective: "Cancel without persisting partial output.",
      workItem: null,
    });
    const { run: cancelableRun } = await client.startAssignmentTeamRun({
      teamId: approvalTeam.id,
      expectedRevision: approvalTeam.revision,
      idempotencyKey: "assignment-permission-cancel",
      assignmentId: canceledAssignment.id,
      expectedAssignmentRevision: canceledAssignment.revision,
      workspaceId,
    });
    await waitForRunStatus(client, cancelableRun.id, "waiting_for_permission");
    const { run: canceledRun } = await client.cancelTeamRun(cancelableRun.id);
    const canceledArtifacts = await client.listAssignmentArtifacts({
      assignmentId: canceledAssignment.id,
      limit: 100,
    });
    expect(canceledRun.state.status).toBe("canceled");
    expect(canceledArtifacts.artifacts).toEqual([]);
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
  }
}, 180_000);
